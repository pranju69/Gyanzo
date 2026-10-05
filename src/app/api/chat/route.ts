import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { loadPdfBytes } from '@/lib/pdf-store';
import { createChatCompletion, AiRateLimitError } from '@/lib/ai';
import ZAI from 'z-ai-web-dev-sdk';
import { extractText, getDocumentProxy } from 'unpdf';

/**
 * AI Study Chat — scoped to the signed-in user's email. Each subject gets
 * its own conversation scope (subjectId = null is the "No subject
 * selected" scope), and history is persisted in SQLite so the chat
 * survives navigation and reloads.
 *
 * GET    /api/chat?email=<email>&subjectId=<id|''>  → { ok, messages }
 * POST   /api/chat { email, subjectId?, message }   → { ok, userMessage, reply }
 * DELETE /api/chat?email=<email>&subjectId=<id|''>  → { ok }
 *
 * POST 429 { error: 'rate_limited' } — the shared LLM quota was exhausted;
 * the request already retried with backoff server-side, the client shows a
 * localised "AI is busy" message instead of a generic failure.
 *
 * When a subject is selected, the text of the user's uploaded PDFs for
 * that subject is extracted server-side (unpdf) and passed to the model
 * as document context, capped to keep prompts bounded.
 */

export const runtime = 'nodejs';

/* AI generation can take well over the 10 s default — Vercel Hobby cap. */
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_MESSAGE_CHARS = 4000;
const HISTORY_TURNS = 12; // previous messages sent to the model
const STORED_MESSAGES = 200; // messages kept per scope
const PER_DOC_CHARS = 4000; // extracted text per PDF
const TOTAL_CONTEXT_CHARS = 12000; // total document context cap
const MAX_CONTEXT_DOCS = 5;

function scopeOf(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s.length > 0 ? s : null;
}

/* ── GET → conversation history (oldest first) ─────────────── */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();
  const subjectId = scopeOf(searchParams.get('subjectId'));

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    const rows = await db.chatMessage.findMany({
      where: { userEmail: email, subjectId },
      orderBy: { createdAt: 'asc' },
      take: STORED_MESSAGES,
    });
    return NextResponse.json({
      ok: true,
      messages: rows.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error('[chat/GET] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/* ── Document context from the subject's uploaded PDFs ─────── */
async function buildDocumentContext(
  email: string,
  subjectName: string
): Promise<string | null> {
  let pdfs: { name: string; storedAs: string }[] = [];
  try {
    pdfs = await db.pdf.findMany({
      where: { userEmail: email, subjectName },
      orderBy: { createdAt: 'desc' },
      take: MAX_CONTEXT_DOCS,
      select: { name: true, storedAs: true, blobUrl: true },
    });
  } catch (error) {
    console.error('[chat/POST] pdf lookup failed:', error);
    return null;
  }

  const parts: string[] = [];
  let used = 0;
  for (const p of pdfs) {
    if (used >= TOTAL_CONTEXT_CHARS) break;
    try {
      const buf = await loadPdfBytes(p);
      const doc = await getDocumentProxy(new Uint8Array(buf));
      const { text } = await extractText(doc, { mergePages: true });
      const clean = String(text)
        .replace(/\s+/g, ' ')
        .trim();
      if (!clean) continue;
      const slice = clean.slice(0, Math.min(PER_DOC_CHARS, TOTAL_CONTEXT_CHARS - used));
      used += slice.length;
      parts.push(`--- ${p.name} ---\n${slice}`);
    } catch (error) {
      // A single unreadable PDF must not break the whole chat.
      console.warn('[chat/POST] text extraction failed for', p.storedAs, error);
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/* ── System prompt ─────────────────────────────────────────── */
function buildSystemPrompt(subjectName: string | null, docContext: string | null) {
  const base =
    'You are Gyanzo, a friendly AI study companion inside the Gyanzo study app. ' +
    'You help students understand their course material: explain clearly, summarize, ' +
    'answer questions and give practical exam-focused study advice. ' +
    'Reply in the same language the student writes in. Keep answers structured with ' +
    'short paragraphs and bullet points where helpful, and stay encouraging.';

  if (subjectName && docContext) {
    return (
      `${base}\n\n` +
      `The student selected the subject "${subjectName}". Below is the text extracted ` +
      'from the study PDFs they uploaded for this subject — treat it as the primary ' +
      'source for questions about this subject. If the answer is not in the material, ' +
      'say so briefly and answer from your general knowledge.\n\n' +
      `STUDY MATERIAL:\n${docContext}`
    );
  }
  if (subjectName) {
    return (
      `${base}\n\n` +
      `The student selected the subject "${subjectName}", but no readable document text ` +
      'is available for it yet. Answer from your general knowledge; if the question is ' +
      'about their specific documents, gently suggest uploading the PDFs in the PDF Library.'
    );
  }
  return (
    `${base}\n\n` +
    'No subject is selected, so you do not have access to the student\u2019s documents. ' +
    'Answer from your general knowledge.'
  );
}

/* ── POST → ask the AI, persist both turns ─────────────────── */
export async function POST(request: Request) {
  let body: {
    email?: unknown;
    subjectId?: unknown;
    message?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const subjectId = scopeOf(body.subjectId);
  const message = typeof body.message === 'string' ? body.message.trim() : '';

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }
  if (!message || message.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    /* Resolve the subject (must belong to this user) */
    let subjectName: string | null = null;
    if (subjectId) {
      const subject = await db.subject.findFirst({
        where: { id: subjectId, userEmail: email },
        select: { name: true },
      });
      subjectName = subject?.name ?? null;
    }

    /* Recent history for multi-turn context */
    const history = await db.chatMessage.findMany({
      where: { userEmail: email, subjectId },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_TURNS,
    });
    history.reverse();

    const docContext = subjectName
      ? await buildDocumentContext(email, subjectName)
      : null;

    const zai = await ZAI.create();
    const completion = await createChatCompletion(zai, {
      messages: [
        { role: 'assistant', content: buildSystemPrompt(subjectName, docContext) },
        ...history.map((m) => ({
          role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
          content: m.content,
        })),
        { role: 'user', content: message },
      ],
      thinking: { type: 'disabled' },
    });

    const reply = completion.choices[0]?.message?.content?.trim();
    if (!reply) throw new Error('empty completion');

    const [userMessage, assistantMessage] = await db.$transaction([
      db.chatMessage.create({
        data: { userEmail: email, subjectId, role: 'user', content: message },
      }),
      db.chatMessage.create({
        data: { userEmail: email, subjectId, role: 'assistant', content: reply },
      }),
    ]);

    return NextResponse.json({
      ok: true,
      userMessage: {
        id: userMessage.id,
        role: userMessage.role,
        content: userMessage.content,
        createdAt: userMessage.createdAt.toISOString(),
      },
      reply: {
        id: assistantMessage.id,
        role: assistantMessage.role,
        content: assistantMessage.content,
        createdAt: assistantMessage.createdAt.toISOString(),
      },
    });
  } catch (error) {
    if (error instanceof AiRateLimitError) {
      console.warn('[chat/POST] LLM rate limited after retries');
      return NextResponse.json(
        { ok: false, error: 'rate_limited' },
        { status: 429 }
      );
    }
    console.error('[chat/POST] ai error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/* ── DELETE → clear a conversation scope ───────────────────── */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();
  const subjectId = scopeOf(searchParams.get('subjectId'));

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    await db.chatMessage.deleteMany({ where: { userEmail: email, subjectId } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[chat/DELETE] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}
