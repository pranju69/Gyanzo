import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { loadPdfBytes } from '@/lib/pdf-store';
import ZAI from 'z-ai-web-dev-sdk';
import { createChatCompletion } from '@/lib/ai';
import { extractText, getDocumentProxy } from 'unpdf';

/**
 * Formula Sheet — AI-extracted formula sheets for one subject: every
 * formula comes with its variables (symbol + meaning), one worked
 * numeric example and a topic tag. The subject's uploaded PDFs are the
 * primary source (extracted server-side via unpdf); with no readable
 * documents the model falls back to the subject's typical syllabus.
 *
 * GET    /api/formula-sheet?email=<email>              → { ok, sheets }
 * POST   /api/formula-sheet { email, subjectId, lang? } → { ok, sheet }
 * DELETE /api/formula-sheet?email=<email>&id=<id>      → { ok }
 */

export const runtime = 'nodejs';

/* AI generation can take well over the 10 s default — Vercel Hobby cap. */
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PER_DOC_CHARS = 6000; // extracted text per PDF
const TOTAL_CONTEXT_CHARS = 24000; // total document context cap
const MAX_CONTEXT_DOCS = 5;
const STORED_SHEETS = 50; // sheets listed per user
const MAX_FORMULAS = 14; // hard clamp on parsed formulas

const LANG_NAMES: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  mr: 'Marathi',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
};

type FormulaVariable = { symbol: string; meaning: string };
type FormulaItem = {
  name: string;
  formula: string;
  variables: FormulaVariable[];
  example: string;
  topic: string;
};

type SheetDTO = {
  id: string;
  subjectId: string | null;
  subjectName: string;
  title: string;
  formulas: FormulaItem[];
  createdAt: string;
};

/* ── Shape a DB row for the client (formulas JSON parsed safely) ───── */
function serialize(row: {
  id: string;
  subjectId: string | null;
  subjectName: string;
  title: string;
  formulas: string;
  createdAt: Date;
}): SheetDTO {
  let formulas: FormulaItem[] = [];
  try {
    const parsed: unknown = JSON.parse(row.formulas);
    if (Array.isArray(parsed)) {
      formulas = parsed
        .map((f) => {
          const item = (f ?? {}) as Record<string, unknown>;
          const s = (v: unknown): string =>
            typeof v === 'string'
              ? v.trim()
              : typeof v === 'number'
                ? String(v)
                : '';
          const variables: FormulaVariable[] = Array.isArray(item.variables)
            ? (item.variables as unknown[])
                .map((v) => {
                  const vr = (v ?? {}) as Record<string, unknown>;
                  return {
                    symbol: s(vr.symbol),
                    meaning: s(vr.meaning),
                  };
                })
                .filter((v) => v.symbol || v.meaning)
            : [];
          return {
            name: s(item.name),
            formula: s(item.formula),
            variables,
            example: s(item.example),
            topic: s(item.topic),
          };
        })
        .filter((f) => f.name || f.formula);
    }
  } catch {
    /* keep the empty fallback */
  }
  return {
    id: row.id,
    subjectId: row.subjectId,
    subjectName: row.subjectName,
    title: row.title,
    formulas,
    createdAt: row.createdAt.toISOString(),
  };
}

/* ── Extract text from the given PDFs (single bad PDF can't break it) ── */
async function extractPdfText(
  rows: { name: string; storedAs: string }[]
): Promise<string | null> {
  const parts: string[] = [];
  let used = 0;
  for (const p of rows) {
    if (used >= TOTAL_CONTEXT_CHARS) break;
    try {
      const buf = await loadPdfBytes(p);
      const doc = await getDocumentProxy(new Uint8Array(buf));
      const { text } = await extractText(doc, { mergePages: true });
      const clean = String(text).replace(/\s+/g, ' ').trim();
      if (!clean) continue;
      const slice = clean.slice(
        0,
        Math.min(PER_DOC_CHARS, TOTAL_CONTEXT_CHARS - used)
      );
      used += slice.length;
      parts.push(`--- ${p.name} ---\n${slice}`);
    } catch (error) {
      console.warn(
        '[formula-sheet/POST] text extraction failed for',
        p.storedAs,
        error
      );
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
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

function asSheetObj(parsed: unknown): Record<string, unknown> | null {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.formulas)) {
      return obj;
    }
  }
  return null;
}

/* Try to parse a candidate as the sheet JSON object. Handles replies
   that are double-encoded as a JSON string literal (the model's habit),
   fenced markdown, JSON embedded in prose, or slightly broken JSON. */
function tryParseSheet(candidate: string): Record<string, unknown> | null {
  const attempts = [candidate, repairJson(candidate)];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const parsed: unknown = JSON.parse(attempt);
      const direct = asSheetObj(parsed);
      if (direct) return direct;
      /* Double-encoded: the reply is a JSON string literal wrapping the
         actual object — try the inner text (raw + repaired). */
      if (typeof parsed === 'string') {
        for (const inner of [parsed, repairJson(parsed)]) {
          if (!inner) continue;
          try {
            const obj = asSheetObj(JSON.parse(inner));
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

function parseSheet(
  raw: string,
  fallbackTitle: string
): { title: string; formulas: FormulaItem[] } | null {
  /* 1) The reply as-is (covers double-encoded string replies). */
  let obj = tryParseSheet(raw.trim());
  /* 2) A fenced ```json block inside the reply. */
  if (!obj) {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) obj = tryParseSheet(fence[1].trim());
  }
  /* 3) Prose around the JSON — slice from the first { to the last }. */
  if (!obj) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      obj = tryParseSheet(raw.slice(start, end + 1));
    }
  }
  if (!obj) return null;

  const str = (v: unknown): string =>
    typeof v === 'string'
      ? v.trim()
      : typeof v === 'number'
        ? String(v)
        : '';
  const formulas: FormulaItem[] = (Array.isArray(obj.formulas)
    ? obj.formulas
    : []
  )
    .slice(0, MAX_FORMULAS)
    .map((f) => {
      const item = (f ?? {}) as Record<string, unknown>;
      const variables: FormulaVariable[] = Array.isArray(item.variables)
        ? (item.variables as unknown[])
            .slice(0, 12)
            .map((v) => {
              const vr = (v ?? {}) as Record<string, unknown>;
              return { symbol: str(vr.symbol), meaning: str(vr.meaning) };
            })
            .filter((v) => v.symbol || v.meaning)
        : [];
      return {
        name: str(item.name),
        formula: str(item.formula),
        variables,
        example: str(item.example),
        topic: str(item.topic),
      };
    })
    .filter((f) => f.name || f.formula);

  if (formulas.length === 0) return null;
  const title =
    typeof obj.title === 'string' && obj.title.trim()
      ? obj.title.trim()
      : fallbackTitle;
  return { title, formulas };
}

/* ── System prompt ─────────────────────────────────────────────────── */
function buildSystemPrompt(
  subjectName: string,
  langName: string,
  docContext: string | null
): string {
  const shape =
    'Respond with ONLY a valid JSON object — no markdown fences, no commentary — in exactly this shape:\n' +
    '{"title": string, "formulas": [{"name": string, "formula": string, "variables": [{"symbol": string, "meaning": string}, ...], "example": string, "topic": string}, ...]}\n' +
    '"formula" is plain text with unicode symbols like \u00d7 \u00f7 \u221a \u03c0 \u2211 \u222b \u00b2 \u00b3 \u2264 \u2260 \u0394 \u03b8 \u03c9 \u2014 no LaTeX, no markdown. ' +
    '"example" is ONE worked numeric example (plug real numbers in and give the result). ' +
    '"topic" is a short grouping tag. Include 6 to 12 of the most important formulas. ' +
    `Write all names, meanings, examples and the title in ${langName}.`;

  const base =
    `You are the Formula Sheet engine of Gyanzo, an AI study companion for students. ` +
    `Extract the most important formulas for the subject "${subjectName}".`;

  if (docContext) {
    return (
      `${base}\n\nBase the sheet on the study material below as the primary source — ` +
      `cover its formulas faithfully and completely.\n\nSTUDY MATERIAL:\n${docContext}\n\n${shape}`
    );
  }
  return (
    `${base}\n\nNo readable documents are available for this subject, so build the sheet ` +
    `from your general knowledge of the typical college syllabus for "${subjectName}".\n\n${shape}`
  );
}

/* ── GET → the user's saved formula sheets (newest first) ──────────── */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    const rows = await db.formulaSheet.findMany({
      where: { userEmail: email },
      orderBy: { createdAt: 'desc' },
      take: STORED_SHEETS,
    });
    return NextResponse.json({ ok: true, sheets: rows.map(serialize) });
  } catch (error) {
    console.error('[formula-sheet/GET] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/* ── POST → generate a formula sheet with the LLM and persist it ───── */
export async function POST(request: Request) {
  let body: {
    email?: unknown;
    subjectId?: unknown;
    lang?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  const email =
    typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const subjectId =
    typeof body.subjectId === 'string' ? body.subjectId.trim() : '';
  const langName =
    LANG_NAMES[typeof body.lang === 'string' ? body.lang : 'en'] ?? 'English';

  if (!EMAIL_RE.test(email) || !subjectId) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    /* Resolve the subject (must belong to this user) */
    const subject = await db.subject.findFirst({
      where: { id: subjectId, userEmail: email },
      select: { name: true },
    });
    if (!subject) {
      return NextResponse.json(
        { ok: false, error: 'notFound' },
        { status: 404 }
      );
    }

    /* The subject's PDFs are the primary source (≤ 5 documents) */
    const docs = await db.pdf.findMany({
      where: { userEmail: email, subjectName: subject.name },
      orderBy: { createdAt: 'desc' },
      take: MAX_CONTEXT_DOCS,
      select: { name: true, storedAs: true, blobUrl: true },
    });
    const docContext = docs.length > 0 ? await extractPdfText(docs) : null;

    const zai = await ZAI.create();
    const completion = await createChatCompletion(zai, {
      messages: [
        {
          role: 'assistant',
          content: buildSystemPrompt(subject.name, langName, docContext),
        },
        {
          role: 'user',
          content: `Extract the most important formulas for my subject "${subject.name}".`,
        },
      ],
      thinking: { type: 'disabled' },
    });

    const raw = completion.choices[0]?.message?.content ?? '';
    if (!raw.trim()) throw new Error('empty completion');

    /* Parse robustly; a reply we cannot shape into formulas is an error —
       never persist garbage. */
    const parsed = parseSheet(raw, subject.name);
    if (!parsed) throw new Error('unparseable formula sheet reply');

    const row = await db.formulaSheet.create({
      data: {
        userEmail: email,
        subjectId,
        subjectName: subject.name,
        title: parsed.title,
        formulas: JSON.stringify(parsed.formulas),
      },
    });

    return NextResponse.json({ ok: true, sheet: serialize(row) });
  } catch (error) {
    console.error('[formula-sheet/POST] ai error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/* ── DELETE → remove one saved formula sheet ───────────────────────── */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();
  const id = (searchParams.get('id') ?? '').trim();

  if (!EMAIL_RE.test(email) || !id) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    await db.formulaSheet.deleteMany({ where: { id, userEmail: email } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[formula-sheet/DELETE] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}
