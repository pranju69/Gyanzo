import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { loadPdfBytes } from '@/lib/pdf-store';
import ZAI from 'z-ai-web-dev-sdk';
import { createChatCompletion } from '@/lib/ai';
import { extractText, getDocumentProxy } from 'unpdf';

/**
 * Voice Tutor — the spoken sibling of AI Study Chat, but fully stateless:
 * no DB persistence, no GET/DELETE. The client keeps the conversation in
 * memory and sends the recent turns along with each request.
 *
 * POST /api/voice-tutor { email, subjectId?, message, history?, lang? }
 *          → { ok, reply }
 *
 * When a subject is given (and belongs to the user), the text of its
 * uploaded PDFs (unpdf, capped) is the primary source; otherwise the
 * tutor answers from general knowledge. Replies are strictly
 * speakable: short conversational sentences, no markdown/lists/emoji —
 * the browser reads them aloud with speechSynthesis.
 */

export const runtime = 'nodejs';

/* AI generation can take well over the 10 s default — Vercel Hobby cap. */
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_TURNS = 8; // previous turns accepted from the client
const MAX_TURN_CHARS = 2000; // per-history-turn content cap
const PER_DOC_CHARS = 4000; // extracted text per PDF
const TOTAL_CONTEXT_CHARS = 12000; // total document context cap
const MAX_CONTEXT_DOCS = 5;

const LANG_NAMES: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  mr: 'Marathi',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
};

type Turn = { role: 'user' | 'assistant'; content: string };

/* ── Sanitize the client-sent history (last 8 valid turns) ─────── */
function sanitizeHistory(raw: unknown): Turn[] {
  if (!Array.isArray(raw)) return [];
  const turns: Turn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const it = item as Record<string, unknown>;
    const role =
      it.role === 'user' || it.role === 'assistant' ? it.role : null;
    if (!role || typeof it.content !== 'string') continue;
    const content = it.content.trim().slice(0, MAX_TURN_CHARS);
    if (!content) continue;
    turns.push({ role, content });
  }
  return turns.slice(-MAX_HISTORY_TURNS);
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
        '[voice-tutor/POST] text extraction failed for',
        p.storedAs,
        error
      );
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/* ── System prompt — strictly speakable answers ─────────────────── */
function buildSystemPrompt(
  subjectName: string | null,
  langName: string,
  docContext: string | null
): string {
  const base =
    'You are Gyanzo\u2019s Voice Tutor, a friendly spoken tutor for students. ' +
    'Answer ONLY with what you say out loud: 2-4 short conversational sentences, ' +
    'warm and encouraging tone, NO markdown, NO lists, NO emoji, no stage directions. ' +
    'If study material is provided, ground your answer in it.';

  if (subjectName && docContext) {
    return (
      `${base}\n\n` +
      `The student selected the subject "${subjectName}". The text below is extracted ` +
      'from the study PDFs they uploaded for this subject \u2014 treat it as the primary ' +
      'source; if the answer is not in the material, say so briefly and answer from ' +
      `your general knowledge.\n\nSTUDY MATERIAL:\n${docContext}\n\nAnswer in ${langName}.`
    );
  }
  if (subjectName) {
    return (
      `${base}\n\n` +
      `The student selected the subject "${subjectName}", but no readable document text ` +
      'is available for it, so answer from your general knowledge. ' +
      `Answer in ${langName}.`
    );
  }
  return (
    `${base}\n\n` +
    'No subject is selected, so you do not have access to the student\u2019s documents. ' +
    `Answer in ${langName}.`
  );
}

/* ── POST → one speakable answer (no persistence) ───────────────── */
export async function POST(request: Request) {
  let body: {
    email?: unknown;
    subjectId?: unknown;
    message?: unknown;
    history?: unknown;
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
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const langName =
    LANG_NAMES[typeof body.lang === 'string' ? body.lang : 'en'] ?? 'English';
  const history = sanitizeHistory(body.history);

  if (!EMAIL_RE.test(email) || !message || message.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    /* Resolve the subject (must belong to this user) + document context */
    let subjectName: string | null = null;
    let docContext: string | null = null;
    if (subjectId) {
      const subject = await db.subject.findFirst({
        where: { id: subjectId, userEmail: email },
        select: { name: true },
      });
      if (subject) {
        subjectName = subject.name;
        const pdfs = await db.pdf.findMany({
          where: { userEmail: email, subjectName: subject.name },
          orderBy: { createdAt: 'desc' },
          take: MAX_CONTEXT_DOCS,
          select: { name: true, storedAs: true, blobUrl: true },
        });
        if (pdfs.length > 0) docContext = await extractPdfText(pdfs);
      }
    }

    const zai = await ZAI.create();
    const completion = await createChatCompletion(zai, {
      messages: [
        { role: 'assistant', content: buildSystemPrompt(subjectName, langName, docContext) },
        ...history.map((t) => ({ role: t.role, content: t.content })),
        { role: 'user', content: message },
      ],
      thinking: { type: 'disabled' },
    });

    const reply = completion.choices[0]?.message?.content?.trim();
    if (!reply) throw new Error('empty completion');

    return NextResponse.json({ ok: true, reply });
  } catch (error) {
    console.error('[voice-tutor/POST] ai error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}
