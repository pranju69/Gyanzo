import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { loadPdfBytes } from '@/lib/pdf-store';
import { AiNotConfiguredError, getAi } from '@/lib/ai-client';
import { createChatCompletion } from '@/lib/ai';
import { extractText, getDocumentProxy } from 'unpdf';
import { pushNotification } from '@/lib/notify';

/**
 * Smart Summary — AI-generated structured study summaries, scoped to the
 * signed-in user's email. A summary targets one subject: either ALL of the
 * subject's uploaded PDFs or one specific document. The extracted PDF text
 * (unpdf) is the primary source; with no readable documents the model falls
 * back to general knowledge of the subject's typical syllabus.
 *
 * GET    /api/summaries?email=<email>                 → { ok, summaries }
 * POST   /api/summaries { email, subjectId, documentId?, length, lang? }
 *          → { ok, summary }
 * DELETE /api/summaries?email=<email>&id=<id>         → { ok }
 */

export const runtime = 'nodejs';

/* AI generation can take well over the 10 s default — Vercel Hobby cap. */
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const LENGTHS = ['short', 'medium', 'detailed', 'bullet'] as const;
type SummaryLength = (typeof LENGTHS)[number];

const PER_DOC_CHARS = 6000; // extracted text per PDF
const TOTAL_CONTEXT_CHARS = 24000; // total document context cap
const MAX_CONTEXT_DOCS = 5;
const STORED_SUMMARIES = 50; // summaries listed per user

/* Per-length writing instructions for the model */
const LENGTH_SPEC: Record<SummaryLength, string> = {
  short:
    'Length = SHORT: a 2-3 sentence overview, then 1-2 sections with 3-4 terse bullets each. ' +
    'Compress ruthlessly — keep only the absolute essentials a student glances at right before the exam. ' +
    'Stay under 150 words in total.',
  medium:
    'Length = MEDIUM: a 3-4 sentence overview, then 3-5 sections with 3-5 bullets each. ' +
    'Around 200-350 words in total — cover the material noticeably more broadly than a short summary.',
  detailed:
    'Length = DETAILED: a 4-6 sentence overview, then 5-8 sections with 4-6 bullets each. ' +
    'Around 450-700 words in total. Expand each bullet into a fuller explanation (1-2 sentences) that ' +
    'unpacks the material\u2019s own terms, numbers and relationships, and cover EVERY topic the material ' +
    'touches — while staying strictly grounded in it.',
  bullet:
    'Style = BULLET-POINT: the overview must be an empty string, then 4-8 sections whose bullets are ' +
    'dense, exam-ready key points (3-6 per section). No full paragraphs anywhere — every line is a crisp ' +
    'revision bullet lifted from the material.',
};

const LANG_NAMES: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  mr: 'Marathi',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
};

type SummaryContent = {
  overview: string;
  sections: { heading: string; bullets: string[] }[];
};

type SummaryDTO = {
  id: string;
  subjectId: string | null;
  subjectName: string;
  documentLabel: string;
  length: string;
  title: string;
  content: SummaryContent;
  createdAt: string;
};

/* ── Shape a DB row for the client (content JSON parsed safely) ── */
function serialize(row: {
  id: string;
  subjectId: string | null;
  subjectName: string;
  documentLabel: string;
  length: string;
  title: string;
  content: string;
  createdAt: Date;
}): SummaryDTO {
  let content: SummaryContent = { overview: '', sections: [] };
  try {
    const parsed = JSON.parse(row.content) as SummaryContent;
    if (parsed && typeof parsed === 'object') {
      content = {
        overview: typeof parsed.overview === 'string' ? parsed.overview : '',
        sections: Array.isArray(parsed.sections)
          ? parsed.sections.map((s) => ({
              heading: typeof s?.heading === 'string' ? s.heading : '',
              bullets: Array.isArray(s?.bullets)
                ? s.bullets.map(String)
                : [],
            }))
          : [],
      };
    }
  } catch {
    /* keep the empty fallback */
  }
  return {
    id: row.id,
    subjectId: row.subjectId,
    subjectName: row.subjectName,
    documentLabel: row.documentLabel,
    length: row.length,
    title: row.title,
    content,
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
        '[summaries/POST] text extraction failed for',
        p.storedAs,
        error
      );
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/* ── Parse the model's reply into the content shape (robust) ──────── */
/* Repair broken JSON by rebuilding it with balanced brackets: mismatched
   closers are substituted with the expected one (models occasionally drop
   or shift a brace), truncated tails get their missing closers appended. */
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

function asSummaryObj(parsed: unknown): Record<string, unknown> | null {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.sections) || typeof obj.overview === 'string') {
      return obj;
    }
  }
  return null;
}

/* Try to parse a candidate as the summary JSON object. Handles replies
   that are double-encoded as a JSON string literal (the model's habit),
   fenced markdown, JSON embedded in prose, or slightly broken JSON. */
function tryParseSummary(candidate: string): Record<string, unknown> | null {
  const attempts = [candidate, repairJson(candidate)];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const parsed: unknown = JSON.parse(attempt);
      const direct = asSummaryObj(parsed);
      if (direct) return direct;
      /* Double-encoded: the reply is a JSON string literal wrapping the
         actual object — try the inner text (raw + repaired). */
      if (typeof parsed === 'string') {
        for (const inner of [parsed, repairJson(parsed)]) {
          if (!inner) continue;
          try {
            const obj = asSummaryObj(JSON.parse(inner));
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

function parseContent(
  raw: string,
  fallbackTitle: string
): { title: string; content: SummaryContent } {
  /* 1) The reply as-is (covers double-encoded string replies). */
  let obj = tryParseSummary(raw.trim());
  /* 2) A fenced ```json block inside the reply. */
  if (!obj) {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) obj = tryParseSummary(fence[1].trim());
  }
  /* 3) Prose around the JSON — slice from the first { to the last }. */
  if (!obj) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      obj = tryParseSummary(raw.slice(start, end + 1));
    }
  }

  if (obj) {
    const sections = Array.isArray(obj.sections) ? obj.sections : [];
    const content: SummaryContent = {
      overview:
        typeof obj.overview === 'string' ? obj.overview.trim() : '',
      sections: sections
        .map((s) => {
          const sec = (s ?? {}) as Record<string, unknown>;
          const heading =
            typeof sec.heading === 'string' ? sec.heading.trim() : '';
          const bullets = Array.isArray(sec.bullets)
            ? sec.bullets
                .map((b) => String(b).replace(/^[-•*]\s*/, '').trim())
                .filter(Boolean)
            : [];
          return { heading, bullets };
        })
        .filter((s) => s.heading || s.bullets.length > 0),
    };
    if (content.overview || content.sections.length > 0) {
      const title =
        typeof obj.title === 'string' && obj.title.trim()
          ? obj.title.trim()
          : fallbackTitle;
      return { title, content };
    }
  }

  // Fallback: treat the whole reply as one heading-less bullet section.
  const lines = raw
    .trim()
    .split('\n')
    .map((l) => l.replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean);
  return {
    title: fallbackTitle,
    content: {
      overview: '',
      sections: lines.length > 0 ? [{ heading: '', bullets: lines }] : [],
    },
  };
}

/* ── System prompt ─────────────────────────────────────────────────── */
function buildSystemPrompt(
  subjectName: string,
  length: SummaryLength,
  langName: string,
  docContext: string | null
): string {
  const shape =
    'Respond with ONLY a valid JSON object — no markdown fences, no commentary — in exactly this shape:\n' +
    '{"title": string, "overview": string, "sections": [{"heading": string, "bullets": [string, ...]}, ...]}\n' +
    '"title" is a short descriptive title for the summary. "overview" is a flowing intro paragraph ' +
    '(an empty string only when the style explicitly says so). Each section has a concise "heading" ' +
    'and 3-6 "bullets". Headings and bullets are plain text — no markdown symbols, no leading dashes.';

  const base =
    `You are the Smart Summary engine of Gyanzo, an AI study companion for students. ` +
    `Write a clear, structured study summary for the subject "${subjectName}". ` +
    `${LENGTH_SPEC[length]} Write the entire summary in ${langName}.`;

  if (docContext) {
    return (
      `${base}\n\nThe student uploaded the study material below — it is the SINGLE source of truth ` +
      `for this summary. The subject name is only an organisational label: the material may cover a ` +
      `different topic than "${subjectName}", and that is expected — ALWAYS follow the MATERIAL, ` +
      `never the name. Summarize the material faithfully: quote its exact terms, names and figures, ` +
      `and do NOT invent facts that are not in it. Do NOT fall back to a typical "${subjectName}" ` +
      `syllabus.\n\nSTUDY MATERIAL:\n${docContext}\n\n${shape}`
    );
  }
  return (
    `${base}\n\nNo readable documents are available for this subject, so write the summary ` +
    `from your general knowledge of the typical college syllabus for "${subjectName}".\n\n${shape}`
  );
}

/* ── GET → the user's saved summaries (newest first) ───────────────── */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    const rows = await db.summary.findMany({
      where: { userEmail: email },
      orderBy: { createdAt: 'desc' },
      take: STORED_SUMMARIES,
    });
    return NextResponse.json({ ok: true, summaries: rows.map(serialize) });
  } catch (error) {
    console.error('[summaries/GET] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/* ── POST → generate a summary with the LLM and persist it ─────────── */
export async function POST(request: Request) {
  let body: {
    email?: unknown;
    subjectId?: unknown;
    documentId?: unknown;
    length?: unknown;
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
  const documentId =
    typeof body.documentId === 'string' ? body.documentId.trim() : '';
  const length: SummaryLength = (LENGTHS as readonly string[]).includes(
    typeof body.length === 'string' ? body.length : ''
  )
    ? (body.length as SummaryLength)
    : 'medium';
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

    /* Resolve the target documents (one specific PDF or all of them) */
    let docs: { name: string; storedAs: string }[] = [];
    if (documentId && documentId !== 'all') {
      const one = await db.pdf.findFirst({
        where: {
          id: documentId,
          userEmail: email,
          subjectName: subject.name,
        },
        select: { name: true, storedAs: true, blobUrl: true },
      });
      if (one) docs = [one];
    } else {
      docs = await db.pdf.findMany({
        where: { userEmail: email, subjectName: subject.name },
        orderBy: { createdAt: 'desc' },
        take: MAX_CONTEXT_DOCS,
        select: { name: true, storedAs: true, blobUrl: true },
      });
    }
    const documentLabel =
      documentId && documentId !== 'all' && docs.length > 0
        ? docs[0].name
        : 'All documents';

    const docContext = docs.length > 0 ? await extractPdfText(docs) : null;

    const zai = await getAi();
    const completion = await createChatCompletion(zai, {
      messages: [
        {
          role: 'assistant',
          content: buildSystemPrompt(
            subject.name,
            length,
            langName,
            docContext
          ),
        },
        {
          role: 'user',
          content: `Generate a ${length} Smart Summary strictly from my uploaded study material above.`,
        },
      ],
      thinking: { type: 'disabled' },
    });

    const raw = completion.choices[0]?.message?.content ?? '';
    if (!raw.trim()) throw new Error('empty completion');
    const { title, content } = parseContent(raw, subject.name);

    const row = await db.summary.create({
      data: {
        userEmail: email,
        subjectId,
        subjectName: subject.name,
        documentLabel,
        length,
        title,
        content: JSON.stringify(content),
      },
    });

    /* Real-time bell notification (persist + socket fan-out). */
    void pushNotification({
      email,
      type: 'summary',
      params: {
        subject: subject.name,
        doc: documentLabel,
        length,
      },
      actionNav: 'smart-summary',
    });

    return NextResponse.json({ ok: true, summary: serialize(row) });
  } catch (error) {
    if (error instanceof AiNotConfiguredError) {
      console.error('[summaries/POST] AI provider not configured on this host');
      return NextResponse.json(
        { ok: false, error: 'ai_not_configured' },
        { status: 503 }
      );
    }
    console.error('[summaries/POST] ai error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/* ── DELETE → remove one saved summary ─────────────────────────────── */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();
  const id = (searchParams.get('id') ?? '').trim();

  if (!EMAIL_RE.test(email) || !id) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    await db.summary.deleteMany({ where: { id, userEmail: email } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[summaries/DELETE] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}
