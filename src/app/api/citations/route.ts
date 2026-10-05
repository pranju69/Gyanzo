import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { loadPdfBytes } from '@/lib/pdf-store';
import ZAI from 'z-ai-web-dev-sdk';
import { createChatCompletion } from '@/lib/ai';
import { extractText, getDocumentProxy } from 'unpdf';

/**
 * Citation — turns one of the user's uploaded PDFs into a ready-to-paste
 * bibliography entry in one of five major styles. Gyanzo AI extracts the
 * bibliographic metadata (authors / title / year / venue / …) from the
 * document text, but the citation STRING itself is formatted
 * deterministically in code — never by the model — so APA 7, MLA 9,
 * Chicago 17, Harvard and IEEE come out with consistent punctuation.
 *
 * GET    /api/citations?email=<email>                  → { ok, citations }
 * POST   /api/citations { email, pdfId, style, lang? } → { ok, citation }
 * DELETE /api/citations?email=<email>&id=<id>          → { ok }
 */

export const runtime = 'nodejs';

/* AI generation can take well over the 10 s default — Vercel Hobby cap. */
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STYLES = ['apa', 'mla', 'chicago', 'harvard', 'ieee'] as const;
type StyleId = (typeof STYLES)[number];

const CONTEXT_CHARS = 3000; // page-1-heavy text slice fed to the model
const STORED_CITATIONS = 50; // citations listed per user

type BibFields = {
  authors: string; // comma-separated full names ('' when unknown)
  title: string;
  year: string;
  venue: string; // journal / conference / publisher-ish container
  publisher: string;
  city: string;
  edition: string;
  url: string;
  doi: string;
};

type CitationDTO = {
  id: string;
  pdfId: string | null;
  pdfName: string;
  style: string;
  text: string;
  createdAt: string;
};

/* ── Shape a DB row for the client ─────────────────────────────────── */
function serialize(row: {
  id: string;
  pdfId: string | null;
  pdfName: string;
  style: string;
  text: string;
  createdAt: Date;
}): CitationDTO {
  return {
    id: row.id,
    pdfId: row.pdfId,
    pdfName: row.pdfName,
    style: row.style,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
  };
}

/* ── Extract the first pages of the PDF (one bad PDF can't break it) ── */
async function extractPdfText(
  row: { name: string; storedAs: string }
): Promise<string | null> {
  try {
    const buf = await loadPdfBytes(row);
    const doc = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(doc, { mergePages: true });
    const clean = String(text).replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    return clean.slice(0, CONTEXT_CHARS);
  } catch (error) {
    console.warn(
      '[citations/POST] text extraction failed for',
      row.storedAs,
      error
    );
    return null;
  }
}

/* ── Repair broken JSON by rebuilding it with balanced brackets ────── */
function repairJson(text: string): string | null {
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  let out = '';
  for (const ch of text) {
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      if (inStr) esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (inStr) {
      out += ch;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']');
      out += ch;
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (stack.length && stack[stack.length - 1] === ch) {
        stack.pop();
        out += ch;
      } else if (stack.length) {
        // Mismatch: substitute the closer the innermost open expects.
        out += stack.pop();
      }
      // Stray closer with nothing open — drop it.
      continue;
    }
    out += ch;
  }
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, '');
  return out + stack.reverse().join('');
}

function asBibObj(parsed: unknown): Record<string, unknown> | null {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.title === 'string' || typeof obj.authors === 'string') {
      return obj;
    }
  }
  return null;
}

/* Try to parse a candidate as the metadata JSON object. Handles replies
   that are double-encoded as a JSON string literal (the model's habit),
   fenced markdown, JSON embedded in prose, or slightly broken JSON. */
function tryParseBib(candidate: string): Record<string, unknown> | null {
  const attempts = [candidate, repairJson(candidate)];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const parsed: unknown = JSON.parse(attempt);
      const direct = asBibObj(parsed);
      if (direct) return direct;
      /* Double-encoded: the reply is a JSON string literal wrapping the
         actual object — try the inner text (raw + repaired). */
      if (typeof parsed === 'string') {
        for (const inner of [parsed, repairJson(parsed)]) {
          if (!inner) continue;
          try {
            const obj = asBibObj(JSON.parse(inner));
            if (obj) return obj;
          } catch {
            /* next inner attempt */
          }
        }
      }
    } catch {
      /* not the JSON we want */
    }
  }
  return null;
}

function parseFields(raw: string): BibFields | null {
  /* 1) The reply as-is (covers double-encoded string replies). */
  let obj = tryParseBib(raw.trim());
  /* 2) A fenced ```json block inside the reply. */
  if (!obj) {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) obj = tryParseBib(fence[1].trim());
  }
  /* 3) Prose around the JSON — slice from the first { to the last }. */
  if (!obj) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      obj = tryParseBib(raw.slice(start, end + 1));
    }
  }
  if (!obj) return null;

  const str = (v: unknown): string =>
    typeof v === 'string'
      ? v.trim()
      : typeof v === 'number'
        ? String(v)
        : '';
  const fields: BibFields = {
    authors: str(obj.authors),
    title: str(obj.title),
    year: str(obj.year),
    venue: str(obj.venue),
    publisher: str(obj.publisher),
    city: str(obj.city),
    edition: str(obj.edition),
    url: str(obj.url),
    doi: str(obj.doi),
  };
  return Object.values(fields).some(Boolean) ? fields : null;
}

/* ── Deterministic citation formatting (plain text, no italics) ────── */

type ParsedName = { first: string; last: string };

/** "John D. Smith" → { first: "John D.", last: "Smith" };
    "Smith, John D." (exactly one comma) is treated as already inverted. */
function parseName(chunk: string): ParsedName {
  const c = chunk.trim().replace(/\s+/g, ' ').replace(/^,+|,+$/g, '').trim();
  if (!c) return { first: '', last: '' };
  const comma = c.indexOf(',');
  if (comma > 0 && comma === c.lastIndexOf(',')) {
    return {
      last: c.slice(0, comma).trim(),
      first: c.slice(comma + 1).trim(),
    };
  }
  const parts = c.split(' ').filter(Boolean);
  if (parts.length === 1) return { first: '', last: parts[0] };
  return {
    first: parts.slice(0, -1).join(' '),
    last: parts[parts.length - 1],
  };
}

function parseAuthors(field: string): ParsedName[] {
  const raw = (field ?? '')
    .replace(/\s+and\s+/gi, ', ')
    .replace(/[;·|]/g, ',');
  return raw
    .split(',')
    .map(parseName)
    .filter((n) => n.first || n.last);
}

/** "John D." → "J. D." (hyphenated names keep the dash: "J.-P."). */
function initialsOf(first: string): string {
  return first
    .split(/\s+/)
    .filter(Boolean)
    .map((w) =>
      w
        .split('-')
        .map((part) => {
          const core = part.replace(/[^A-Za-zÀ-ÿ]/g, '').replace(/\./g, '');
          return core ? `${core.charAt(0).toUpperCase()}.` : '';
        })
        .filter(Boolean)
        .join('-')
    )
    .filter(Boolean)
    .join(' ');
}

function inverted(n: ParsedName): string {
  const ini = initialsOf(n.first);
  return ini ? `${n.last}, ${ini}` : n.last;
}
function plainName(n: ParsedName): string {
  return n.first ? `${n.first} ${n.last}` : n.last;
}
function initialFirst(n: ParsedName): string {
  const ini = initialsOf(n.first);
  return ini ? `${ini} ${n.last}` : n.last;
}

function apaAuthors(names: ParsedName[]): string {
  const list = names.map(inverted);
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')}, & ${list[list.length - 1]}`;
}

function mlaAuthors(names: ParsedName[]): string {
  const first = inverted(names[0]);
  if (names.length === 1) return first;
  if (names.length === 2) return `${first}, and ${plainName(names[1])}`;
  return `${first}, et al.`;
}

function chicagoAuthors(names: ParsedName[]): string {
  const first = inverted(names[0]);
  if (names.length === 1) return first;
  if (names.length > 3) return `${first}, et al.`;
  const rest = names.slice(1).map(plainName);
  if (rest.length === 1) return `${first}, and ${rest[0]}`;
  return `${first}, ${rest.slice(0, -1).join(', ')}, and ${rest[rest.length - 1]}`;
}

function harvardAuthors(names: ParsedName[]): string {
  const list = names.map(inverted);
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  if (list.length === 3) return `${list[0]}, ${list[1]} and ${list[2]}`;
  return `${list[0]} et al.`;
}

function ieeeAuthors(names: ParsedName[]): string {
  const list = names.map(initialFirst);
  if (list.length === 1) return list[0];
  if (list.length > 6) return `${list[0]} et al.`;
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;
}

/** Append a period unless the text already ends in terminal punctuation. */
function endDot(s: string): string {
  const t = s.trim();
  if (!t) return '';
  return /[.!?…]["”')\]]*$/.test(t) ? t : `${t}.`;
}

/** "2" → "2 ed." / "2nd" → "2nd ed." (already-formatted passes through). */
function formatEdition(edition: string): string {
  const e = edition.trim().replace(/\s+/g, ' ');
  if (!e) return '';
  return /\b(ed|edition|aufl)\b/i.test(e) ? e : `${e} ed.`;
}

function cleanYear(year: string, fallback: string): string {
  const m = (year || '').match(/\d{4}/);
  if (m) return m[0];
  const f = (fallback || '').match(/\d{4}/);
  return f ? f[0] : '';
}

function doiLink(doi: string): string {
  const d = doi.trim().replace(/^doi:\s*/i, '');
  if (!d) return '';
  return /^https?:\/\//i.test(d) ? d : `https://doi.org/${d}`;
}

function squeeze(s: string): string {
  return s.replace(/\s{2,}/g, ' ').trim();
}

function formatApa(
  f: BibFields,
  names: ParsedName[],
  fallbackYear: string
): string {
  const year = cleanYear(f.year, fallbackYear);
  const yearPart = year ? `(${year}).` : '(n.d.).';
  const head = names.length
    ? `${endDot(apaAuthors(names))} ${yearPart}`
    : yearPart;
  let title = f.title.trim();
  if (f.edition && f.publisher) {
    const ed = formatEdition(f.edition).replace(/\.$/, '');
    if (ed) title += ` (${ed})`;
  }
  const parts: string[] = [head, endDot(title)];
  if (f.venue) parts.push(endDot(f.venue));
  if (f.publisher) parts.push(endDot(f.publisher));
  const link = doiLink(f.doi) || f.url.trim();
  if (link) parts.push(link);
  return squeeze(parts.filter(Boolean).join(' '));
}

function formatMla(
  f: BibFields,
  names: ParsedName[],
  fallbackYear: string
): string {
  const year = cleanYear(f.year, fallbackYear);
  const parts: string[] = [
    names.length ? endDot(mlaAuthors(names)) : '',
    endDot(f.title),
  ];
  let tail = year;
  if (f.venue) {
    tail = `${f.venue}${year ? `, ${year}` : ''}`;
  } else if (f.publisher) {
    tail = `${f.city ? `${f.city}: ` : ''}${f.publisher}${year ? `, ${year}` : ''}`;
  }
  parts.push(endDot(tail));
  const link = doiLink(f.doi) || f.url.trim();
  if (link) parts.push(link);
  return squeeze(parts.filter(Boolean).join(' '));
}

function formatChicago(
  f: BibFields,
  names: ParsedName[],
  fallbackYear: string
): string {
  const year = cleanYear(f.year, fallbackYear);
  const parts: string[] = [
    names.length ? endDot(chicagoAuthors(names)) : '',
    endDot(f.title),
  ];
  let tail = year;
  if (f.venue) {
    tail = `${f.venue}${year ? `, ${year}` : ''}`;
  } else if (f.publisher) {
    tail = `${f.city ? `${f.city}: ` : ''}${f.publisher}${year ? `, ${year}` : ''}`;
  }
  parts.push(endDot(tail));
  const link = doiLink(f.doi) || f.url.trim();
  if (link) parts.push(link);
  return squeeze(parts.filter(Boolean).join(' '));
}

function formatHarvard(
  f: BibFields,
  names: ParsedName[],
  fallbackYear: string
): string {
  const year = cleanYear(f.year, fallbackYear);
  const yearPart = `(${year || 'n.d.'}).`;
  const head = names.length
    ? `${endDot(harvardAuthors(names))} ${yearPart}`
    : yearPart;
  let title = f.title.trim();
  if (f.edition && f.publisher) {
    const ed = formatEdition(f.edition).replace(/\.$/, '');
    if (ed) title += ` (${ed})`;
  }
  const parts: string[] = [head, endDot(title)];
  if (f.venue) parts.push(endDot(f.venue));
  if (f.publisher) {
    parts.push(endDot(`${f.city ? `${f.city}: ` : ''}${f.publisher}`));
  }
  const link = doiLink(f.doi) || f.url.trim();
  if (link) parts.push(link);
  return squeeze(parts.filter(Boolean).join(' '));
}

function formatIeee(
  f: BibFields,
  names: ParsedName[],
  fallbackYear: string
): string {
  const year = cleanYear(f.year, fallbackYear);
  const head = names.length ? `${ieeeAuthors(names)}, ` : '';
  const title = f.title.trim().replace(/[.!?,;:]+$/, '');
  const titlePart = title ? `\u201C${title},\u201D ` : '';
  let tail = year;
  if (f.venue) {
    tail = `${f.venue}${year ? `, ${year}` : ''}`;
  } else if (f.publisher) {
    const ed = f.edition ? `${formatEdition(f.edition)} ` : '';
    tail = `${ed}${f.city ? `${f.city}: ` : ''}${f.publisher}${year ? `, ${year}` : ''}`;
  }
  const link = doiLink(f.doi) || f.url.trim();
  return squeeze(
    `${head}${titlePart}${endDot(tail)}${link ? ` ${link}` : ''}`
  );
}

function formatCitation(
  style: StyleId,
  fields: BibFields,
  pdf: { name: string; createdAt: Date }
): string {
  const names = parseAuthors(fields.authors);
  const fallbackYear = pdf.createdAt.toISOString();
  const title =
    fields.title.trim() || pdf.name.replace(/\.pdf$/i, '').trim();
  const effective: BibFields = { ...fields, title };
  switch (style) {
    case 'mla':
      return formatMla(effective, names, fallbackYear);
    case 'chicago':
      return formatChicago(effective, names, fallbackYear);
    case 'harvard':
      return formatHarvard(effective, names, fallbackYear);
    case 'ieee':
      return formatIeee(effective, names, fallbackYear);
    default:
      return formatApa(effective, names, fallbackYear);
  }
}

/* ── GET → the user's saved citations (newest first) ───────────────── */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    const rows = await db.citation.findMany({
      where: { userEmail: email },
      orderBy: { createdAt: 'desc' },
      take: STORED_CITATIONS,
    });
    return NextResponse.json({ ok: true, citations: rows.map(serialize) });
  } catch (error) {
    console.error('[citations/GET] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/* ── POST → extract metadata with the LLM, format in code, persist ── */
export async function POST(request: Request) {
  let body: {
    email?: unknown;
    pdfId?: unknown;
    style?: unknown;
    lang?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  const email =
    typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const pdfId = typeof body.pdfId === 'string' ? body.pdfId.trim() : '';
  const style: StyleId = (STYLES as readonly string[]).includes(
    typeof body.style === 'string' ? body.style : ''
  )
    ? (body.style as StyleId)
    : 'apa';

  if (!EMAIL_RE.test(email) || !pdfId) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    /* Resolve the PDF (must belong to this user) */
    const pdf = await db.pdf.findFirst({
      where: { id: pdfId, userEmail: email },
      select: { name: true, storedAs: true, blobUrl: true, createdAt: true },
    });
    if (!pdf) {
      return NextResponse.json(
        { ok: false, error: 'notFound' },
        { status: 404 }
      );
    }

    const docContext = await extractPdfText(pdf);

    const systemPrompt =
      `You are the Citation engine of Gyanzo, an AI study companion for students. ` +
      `Extract bibliographic metadata from this document. ` +
      `Respond ONLY with JSON ` +
      `{"authors": string (comma-separated full names or ''), "title": string, ` +
      `"year": string, "venue": string (journal/conference/publisher), ` +
      `"publisher": string, "city": string, "edition": string, "url": string, ` +
      `"doi": string} — use empty strings for anything unknown.`;

    const contextBlock = docContext
      ? `\n\nDOCUMENT TEXT (first pages):\n${docContext}`
      : `\n\nNo readable text could be extracted — rely on the document's file name: "${pdf.name}".`;

    const zai = await ZAI.create();
    const completion = await createChatCompletion(zai, {
      messages: [
        { role: 'assistant', content: systemPrompt + contextBlock },
        {
          role: 'user',
          content: `Extract the bibliographic metadata of my document "${pdf.name}".`,
        },
      ],
      thinking: { type: 'disabled' },
    });

    const raw = completion.choices[0]?.message?.content ?? '';
    if (!raw.trim()) throw new Error('empty completion');

    const fields = parseFields(raw) ?? {
      authors: '',
      title: '',
      year: '',
      venue: '',
      publisher: '',
      city: '',
      edition: '',
      url: '',
      doi: '',
    };

    /* The citation string is formatted deterministically in code —
       the model never writes the final text. */
    const text = formatCitation(style, fields, pdf);

    const row = await db.citation.create({
      data: {
        userEmail: email,
        pdfId,
        pdfName: pdf.name,
        style,
        text,
        fields: JSON.stringify(fields),
      },
    });

    return NextResponse.json({ ok: true, citation: serialize(row) });
  } catch (error) {
    console.error('[citations/POST] ai error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/* ── DELETE → remove one saved citation ────────────────────────────── */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();
  const id = (searchParams.get('id') ?? '').trim();

  if (!EMAIL_RE.test(email) || !id) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    await db.citation.deleteMany({ where: { id, userEmail: email } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[citations/DELETE] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}
