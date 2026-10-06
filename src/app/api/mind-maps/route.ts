import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { loadPdfBytes } from '@/lib/pdf-store';
import { AiNotConfiguredError, getAi } from '@/lib/ai-client';
import { createChatCompletion } from '@/lib/ai';
import { extractText, getDocumentProxy } from 'unpdf';

/**
 * Mind Map — AI-generated hierarchical mind maps, scoped to the
 * signed-in user's email. A map targets one subject: the text of the
 * subject's uploaded PDFs (unpdf) is the primary source; with no
 * readable documents the model falls back to general knowledge of the
 * subject's typical syllabus.
 *
 * The tree is stored as JSON `{ root: { title, children: [...] } }`
 * where every node is `{ title: string, children: [...] }`.
 *
 * GET    /api/mind-maps?email=<email>              → { ok, maps }
 * POST   /api/mind-maps { email, subjectId, topic?, lang? }
 *          → { ok, map }
 * DELETE /api/mind-maps?email=<email>&id=<id>      → { ok }
 */

export const runtime = 'nodejs';

/* AI generation can take well over the 10 s default — Vercel Hobby cap. */
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PER_DOC_CHARS = 6000; // extracted text per PDF
const TOTAL_CONTEXT_CHARS = 24000; // total document context cap
const MAX_CONTEXT_DOCS = 5;
const STORED_MAPS = 50; // maps listed per user
const MAX_NODES = 24; // hard cap while coercing the model's tree
const MAX_TOPIC_CHARS = 120;

const LANG_NAMES: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  mr: 'Marathi',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
};

type MMNode = { title: string; children: MMNode[] };

type MapDTO = {
  id: string;
  subjectId: string | null;
  subjectName: string;
  topic: string;
  title: string;
  content: { root: MMNode };
  createdAt: string;
};

/* ── Coerce an unknown value into a well-formed node tree (capped) ── */
function coerceTree(raw: unknown, budget: { left: number }): MMNode | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (budget.left <= 0) return null;
  const obj = raw as Record<string, unknown>;
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  if (!title) return null; // drop nodes with empty titles
  budget.left -= 1;
  const children: MMNode[] = [];
  if (Array.isArray(obj.children)) {
    for (const child of obj.children) {
      if (budget.left <= 0) break;
      const coerced = coerceTree(child, budget);
      if (coerced) children.push(coerced);
    }
  }
  return { title, children };
}

/* ── Shape a DB row for the client (content JSON parsed safely) ── */
function serialize(row: {
  id: string;
  subjectId: string | null;
  subjectName: string;
  topic: string;
  title: string;
  content: string;
  createdAt: Date;
}): MapDTO {
  let root: MMNode = { title: row.subjectName, children: [] };
  try {
    const parsed = JSON.parse(row.content) as { root?: unknown };
    const coerced = coerceTree(parsed?.root, { left: MAX_NODES });
    if (coerced) root = coerced;
  } catch {
    /* keep the fallback root */
  }
  return {
    id: row.id,
    subjectId: row.subjectId,
    subjectName: row.subjectName,
    topic: row.topic,
    title: row.title,
    content: { root },
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
        '[mind-maps/POST] text extraction failed for',
        p.storedAs,
        error
      );
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/* ── Parse the model's reply into the map shape (robust) ──────────── */
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

function asMapObj(parsed: unknown): Record<string, unknown> | null {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (obj.root && typeof obj.root === 'object' && !Array.isArray(obj.root)) {
      return obj;
    }
  }
  return null;
}

/* Try to parse a candidate as the map JSON object. Handles replies that
   are double-encoded as a JSON string literal (the model's habit), fenced
   markdown, JSON embedded in prose, or slightly broken JSON. */
function tryParseMap(candidate: string): Record<string, unknown> | null {
  const attempts = [candidate, repairJson(candidate)];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const parsed: unknown = JSON.parse(attempt);
      const direct = asMapObj(parsed);
      if (direct) return direct;
      /* Double-encoded: the reply is a JSON string literal wrapping the
         actual object — try the inner text (raw + repaired). */
      if (typeof parsed === 'string') {
        for (const inner of [parsed, repairJson(parsed)]) {
          if (!inner) continue;
          try {
            const obj = asMapObj(JSON.parse(inner));
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

function parseMindMap(
  raw: string,
  fallbackTitle: string,
  subjectName: string
): { title: string; root: MMNode } {
  /* 1) The reply as-is (covers double-encoded string replies). */
  let obj = tryParseMap(raw.trim());
  /* 2) A fenced ```json block inside the reply. */
  if (!obj) {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) obj = tryParseMap(fence[1].trim());
  }
  /* 3) Prose around the JSON — slice from the first { to the last }. */
  if (!obj) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      obj = tryParseMap(raw.slice(start, end + 1));
    }
  }

  if (obj) {
    const root = coerceTree(obj.root, { left: MAX_NODES });
    if (root) {
      const title =
        typeof obj.title === 'string' && obj.title.trim()
          ? obj.title.trim()
          : fallbackTitle;
      return { title, root };
    }
  }

  // Fallback: single root named after the subject, the reply's lines as
  // flat children titles (bullets stripped).
  const lines = raw
    .trim()
    .split('\n')
    .map((l) => l.replace(/^[-•*\d.)\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, MAX_NODES - 1);
  return {
    title: fallbackTitle,
    root: {
      title: subjectName,
      children: lines.map((l) => ({ title: l, children: [] })),
    },
  };
}

/* ── System prompt ─────────────────────────────────────────────────── */
function buildSystemPrompt(
  subjectName: string,
  topic: string,
  langName: string,
  docContext: string | null
): string {
  const focus = topic ? ` (focused on the topic "${topic}")` : '';
  const shape =
    'Respond with ONLY a valid JSON object — no markdown fences, no commentary — in exactly this shape:\n' +
    '{"title": string, "root": {"title": string, "children": [{"title": string, "children": [...]}, ...]}}\n' +
    '"title" is a short overall title for the map; the root node\u2019s "title" names the central idea. ' +
    'Depth at most 3 levels (root + 2), 2-5 children per node, at most 18 nodes in total, and every ' +
    'node title must be at most 6 words. Titles are plain text — no markdown symbols, no leading ' +
    `dashes, no numbering. Write every title in ${langName}.`;

  const base =
    `You are the Mind Map engine of Gyanzo, an AI study companion for students. ` +
    `Build a hierarchical mind map for the subject "${subjectName}"${focus}.`;

  if (docContext) {
    return (
      `${base}\n\nBase the map on the study material below as the primary source — organize its ` +
      `key content faithfully into branches.\n\nSTUDY MATERIAL:\n${docContext}\n\n${shape}`
    );
  }
  return (
    `${base}\n\nNo readable documents are available for this subject, so build the map from your ` +
    `general knowledge of the typical college syllabus for "${subjectName}".\n\n${shape}`
  );
}

/* ── GET → the user's saved mind maps (newest first) ───────────────── */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    const rows = await db.mindMap.findMany({
      where: { userEmail: email },
      orderBy: { createdAt: 'desc' },
      take: STORED_MAPS,
    });
    return NextResponse.json({ ok: true, maps: rows.map(serialize) });
  } catch (error) {
    console.error('[mind-maps/GET] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/* ── POST → generate a mind map with the LLM and persist it ────────── */
export async function POST(request: Request) {
  let body: {
    email?: unknown;
    subjectId?: unknown;
    topic?: unknown;
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
  const topic =
    typeof body.topic === 'string'
      ? body.topic.trim().slice(0, MAX_TOPIC_CHARS)
      : '';
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

    /* The subject's most recent PDFs ground the map */
    const docs = await db.pdf.findMany({
      where: { userEmail: email, subjectName: subject.name },
      orderBy: { createdAt: 'desc' },
      take: MAX_CONTEXT_DOCS,
      select: { name: true, storedAs: true, blobUrl: true },
    });
    const docContext = docs.length > 0 ? await extractPdfText(docs) : null;

    const zai = await getAi();
    const completion = await createChatCompletion(zai, {
      messages: [
        {
          role: 'assistant',
          content: buildSystemPrompt(subject.name, topic, langName, docContext),
        },
        {
          role: 'user',
          content: topic
            ? `Generate a mind map for my subject "${subject.name}", focused on the topic "${topic}".`
            : `Generate a mind map for my subject "${subject.name}".`,
        },
      ],
      thinking: { type: 'disabled' },
    });

    const raw = completion.choices[0]?.message?.content ?? '';
    if (!raw.trim()) throw new Error('empty completion');
    const { title, root } = parseMindMap(
      raw,
      `${subject.name}${topic ? ` — ${topic}` : ''}`,
      subject.name
    );

    const row = await db.mindMap.create({
      data: {
        userEmail: email,
        subjectId,
        subjectName: subject.name,
        topic,
        title,
        content: JSON.stringify({ root }),
      },
    });

    return NextResponse.json({ ok: true, map: serialize(row) });
  } catch (error) {
    if (error instanceof AiNotConfiguredError) {
      console.error('[mind-maps/POST] AI provider not configured on this host');
      return NextResponse.json(
        { ok: false, error: 'ai_not_configured' },
        { status: 503 }
      );
    }
    console.error('[mind-maps/POST] ai error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/* ── DELETE → remove one saved mind map ────────────────────────────── */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();
  const id = (searchParams.get('id') ?? '').trim();

  if (!EMAIL_RE.test(email) || !id) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    await db.mindMap.deleteMany({ where: { id, userEmail: email } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[mind-maps/DELETE] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}
