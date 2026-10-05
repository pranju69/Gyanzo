import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import ZAI from 'z-ai-web-dev-sdk';
import { createChatCompletion } from '@/lib/ai';
import { extractPdfSource } from '@/lib/pdf-text';
import { pushNotification } from '@/lib/notify';

/**
 * Revision Notes — AI-generated last-minute revision material, scoped to
 * the signed-in user's email. A note targets one subject: either ALL of
 * the subject's uploaded PDFs or one specific document, in one of three
 * modes:
 *
 *   - one-page            → everything condensed on a single page
 *   - key-concepts        → core ideas explained briefly
 *   - important-questions → exam-style questions worth practicing
 *                           (each point's `detail` holds a model answer)
 *
 * The extracted PDF text (unpdf) is the primary source; with no readable
 * documents the model falls back to general knowledge of the subject's
 * typical syllabus.
 *
 * GET    /api/revision-notes?email=<email>                     → { ok, notes }
 * POST   /api/revision-notes { email, subjectId, documentId?, mode, lang? }
 *          → { ok, note }
 * DELETE /api/revision-notes?email=<email>&id=<id>             → { ok }
 */

export const runtime = 'nodejs';

/* AI generation can take well over the 10 s default — Vercel Hobby cap. */
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MODES = ['one-page', 'key-concepts', 'important-questions'] as const;
type NoteMode = (typeof MODES)[number];

const STORED_NOTES = 50; // notes listed per user

/* Per-mode writing instructions for the model */
const MODE_SPEC: Record<NoteMode, string> = {
  'one-page':
    'Mode = ONE-PAGE NOTES: everything must fit on a single page. A 1-2 sentence ' +
    'overview, then 4-6 sections with 3-5 crisp, high-yield bullets each. ' +
    'Definitions, formulas and must-remember facts come first. Every point\u2019s ' +
    '"detail" must be an empty string. Stay under 350 words in total.',
  'key-concepts':
    'Mode = KEY CONCEPTS: explain the core ideas briefly. A 1-2 sentence overview, ' +
    'then 4-7 sections \u2014 each section heading is one key concept and its 2-3 ' +
    'bullets explain it concisely, no fluff. Every point\u2019s "detail" must be an ' +
    'empty string. Around 250-450 words in total.',
  'important-questions':
    'Mode = IMPORTANT QUESTIONS: list the questions worth practicing before the ' +
    'exam. A 1-2 sentence overview, then 3-6 topical sections; each point\u2019s ' +
    '"text" is an exam-style question and its "detail" is a 1-3 sentence model ' +
    'answer. 5-9 questions total, mixing recall, explanation and application.',
};

const LANG_NAMES: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  mr: 'Marathi',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
};

type NotePoint = { text: string; detail: string };
type NoteContent = {
  overview: string;
  sections: { heading: string; points: NotePoint[] }[];
};

type NoteDTO = {
  id: string;
  subjectId: string | null;
  subjectName: string;
  documentLabel: string;
  mode: string;
  title: string;
  content: NoteContent;
  createdAt: string;
};

/* ── Shape a DB row for the client (content JSON parsed safely) ── */
function serialize(row: {
  id: string;
  subjectId: string | null;
  subjectName: string;
  documentLabel: string;
  mode: string;
  title: string;
  content: string;
  createdAt: Date;
}): NoteDTO {
  let content: NoteContent = { overview: '', sections: [] };
  try {
    const parsed = JSON.parse(row.content) as NoteContent;
    if (parsed && typeof parsed === 'object') {
      content = {
        overview: typeof parsed.overview === 'string' ? parsed.overview : '',
        sections: Array.isArray(parsed.sections)
          ? parsed.sections.map((s) => ({
              heading: typeof s?.heading === 'string' ? s.heading : '',
              points: Array.isArray(s?.points)
                ? s.points.map((p) => ({
                    text: typeof p?.text === 'string' ? p.text : '',
                    detail: typeof p?.detail === 'string' ? p.detail : '',
                  }))
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
    mode: row.mode,
    title: row.title,
    content,
    createdAt: row.createdAt.toISOString(),
  };
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

function asNoteObj(parsed: unknown): Record<string, unknown> | null {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.sections) || typeof obj.overview === 'string') {
      return obj;
    }
  }
  return null;
}

/* Try to parse a candidate as the note JSON object. Handles replies that
   are double-encoded as a JSON string literal (the model's habit), fenced
   markdown, JSON embedded in prose, or slightly broken JSON. */
function tryParseNote(candidate: string): Record<string, unknown> | null {
  const attempts = [candidate, repairJson(candidate)];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const parsed: unknown = JSON.parse(attempt);
      const direct = asNoteObj(parsed);
      if (direct) return direct;
      /* Double-encoded: the reply is a JSON string literal wrapping the
         actual object — try the inner text (raw + repaired). */
      if (typeof parsed === 'string') {
        for (const inner of [parsed, repairJson(parsed)]) {
          if (!inner) continue;
          try {
            const obj = asNoteObj(JSON.parse(inner));
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
): { title: string; content: NoteContent } {
  /* 1) The reply as-is (covers double-encoded string replies). */
  let obj = tryParseNote(raw.trim());
  /* 2) A fenced ```json block inside the reply. */
  if (!obj) {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) obj = tryParseNote(fence[1].trim());
  }
  /* 3) Prose around the JSON — slice from the first { to the last }. */
  if (!obj) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      obj = tryParseNote(raw.slice(start, end + 1));
    }
  }

  if (obj) {
    const sections = Array.isArray(obj.sections) ? obj.sections : [];
    const content: NoteContent = {
      overview:
        typeof obj.overview === 'string' ? obj.overview.trim() : '',
      sections: sections
        .map((s) => {
          const sec = (s ?? {}) as Record<string, unknown>;
          const heading =
            typeof sec.heading === 'string' ? sec.heading.trim() : '';
          /* Preferred shape: points: [{ text, detail }] */
          let points: NotePoint[] = Array.isArray(sec.points)
            ? sec.points
                .map((p) => {
                  const pt = (p ?? {}) as Record<string, unknown>;
                  return {
                    text:
                      typeof pt?.text === 'string'
                        ? pt.text.replace(/^[-•*\d.)\s]+/, '').trim()
                        : '',
                    detail:
                      typeof pt?.detail === 'string' ? pt.detail.trim() : '',
                  };
                })
                .filter((p) => p.text)
            : [];
          /* Tolerate the summary shape: bullets: string[] */
          if (points.length === 0 && Array.isArray(sec.bullets)) {
            points = (sec.bullets as unknown[])
              .map((b) => ({
                text: String(b).replace(/^[-•*\d.)\s]+/, '').trim(),
                detail: '',
              }))
              .filter((p) => p.text);
          }
          return { heading, points };
        })
        .filter((s) => s.heading || s.points.length > 0),
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
      sections:
        lines.length > 0
          ? [{ heading: '', points: lines.map((l) => ({ text: l, detail: '' })) }]
          : [],
    },
  };
}

/* ── System prompt ─────────────────────────────────────────────────── */
function buildSystemPrompt(
  subjectName: string,
  mode: NoteMode,
  langName: string,
  docContext: string | null
): string {
  const shape =
    'Respond with ONLY a valid JSON object — no markdown fences, no commentary — in exactly this shape:\n' +
    '{"title": string, "overview": string, "sections": [{"heading": string, "points": [{"text": string, "detail": string}, ...]}, ...]}\n' +
    '"title" is a short descriptive title for the revision note. "overview" is a short intro paragraph. ' +
    'Each section has a concise "heading" and 3-5 "points". "text" is the point itself; "detail" is an ' +
    'optional elaboration (the model answer for question mode, an empty string otherwise). ' +
    'Headings and texts are plain text — no markdown symbols, no leading dashes, no numbering.';

  const base =
    `You are the Revision Notes engine of Gyanzo, an AI study companion for students. ` +
    `Write last-minute revision material for the subject "${subjectName}". ` +
    `${MODE_SPEC[mode]} Write the entire note in ${langName}.`;

  if (docContext) {
    return (
      `${base}\n\nThe student uploaded the study material below — it is the SINGLE source of truth ` +
      `for this note. The subject name is only an organisational label: the material may cover a ` +
      `different topic than "${subjectName}", and that is expected — ALWAYS follow the MATERIAL, ` +
      `never the name. Base EVERY section and point on the material: quote its exact terms, names ` +
      `and figures, and do NOT invent facts that are not in it. Do NOT fall back to a typical ` +
      `"${subjectName}" syllabus.\n\nSTUDY MATERIAL:\n${docContext}\n\n${shape}`
    );
  }
  return (
    `${base}\n\nNo readable documents are available for this subject, so write the note ` +
    `from your general knowledge of the typical college syllabus for "${subjectName}".\n\n${shape}`
  );
}

/* ── GET → the user's saved revision notes (newest first) ──────────── */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    const rows = await db.revisionNote.findMany({
      where: { userEmail: email },
      orderBy: { createdAt: 'desc' },
      take: STORED_NOTES,
    });
    return NextResponse.json({ ok: true, notes: rows.map(serialize) });
  } catch (error) {
    console.error('[revision-notes/GET] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/* ── POST → generate a revision note with the LLM and persist it ───── */
export async function POST(request: Request) {
  let body: {
    email?: unknown;
    subjectId?: unknown;
    documentId?: unknown;
    mode?: unknown;
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
  const mode: NoteMode = (MODES as readonly string[]).includes(
    typeof body.mode === 'string' ? body.mode : ''
  )
    ? (body.mode as NoteMode)
    : 'one-page';
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
        take: 5,
        select: { name: true, storedAs: true, blobUrl: true },
      });
    }
    const documentLabel =
      documentId && documentId !== 'all' && docs.length > 0
        ? docs[0].name
        : 'All documents';

    let docContext: string | null = null;
    let source: { used: string[]; unreadable: string[] } | null = null;
    if (docs.length > 0) {
      const extracted = await extractPdfSource(docs, {
        perDocChars: 12000,
        totalChars: 36000,
      });
      docContext = extracted.context;
      source = { used: extracted.used, unreadable: extracted.unreadable };
    }

    const zai = await ZAI.create();
    const completion = await createChatCompletion(zai, {
      messages: [
        {
          role: 'assistant',
          content: buildSystemPrompt(
            subject.name,
            mode,
            langName,
            docContext
          ),
        },
        {
          role: 'user',
          content: `Generate revision notes (mode: ${mode}) strictly from my uploaded study material above.`,
        },
      ],
      thinking: { type: 'disabled' },
    });

    const raw = completion.choices[0]?.message?.content ?? '';
    if (!raw.trim()) throw new Error('empty completion');
    const { title, content } = parseContent(raw, subject.name);

    /* Source transparency — which uploaded PDFs actually fed the note */
    const sourcePayload =
      docs.length > 0
        ? {
            kind: docContext ? ('pdf' as const) : ('unreadable' as const),
            used: source?.used ?? [],
            unreadable: source?.unreadable ?? [],
          }
        : null;

    const row = await db.revisionNote.create({
      data: {
        userEmail: email,
        subjectId,
        subjectName: subject.name,
        documentLabel,
        mode,
        title,
        content: JSON.stringify(content),
      },
    });

    /* Real-time bell notification (persist + socket fan-out). */
    void pushNotification({
      email,
      type: 'note',
      params: {
        subject: subject.name,
        doc: documentLabel,
        mode,
      },
      actionNav: 'revision-notes',
    });

    return NextResponse.json({ ok: true, note: serialize(row), source: sourcePayload });
  } catch (error) {
    console.error('[revision-notes/POST] ai error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/* ── DELETE → remove one saved revision note ───────────────────────── */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();
  const id = (searchParams.get('id') ?? '').trim();

  if (!EMAIL_RE.test(email) || !id) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    await db.revisionNote.deleteMany({ where: { id, userEmail: email } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[revision-notes/DELETE] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}
