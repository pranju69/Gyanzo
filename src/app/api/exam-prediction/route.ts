import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { AiNotConfiguredError, getAi } from '@/lib/ai-client';
import { createChatCompletion } from '@/lib/ai';
import { extractPdfText } from '@/lib/pdf-text';

/**
 * Exam Prediction — AI-flagged questions most likely to appear in the
 * user's exam, scoped to the signed-in user's email. A run targets one
 * of the user's subjects: the extracted text of its uploaded PDFs is
 * the primary source, with a general-syllabus fallback when the subject
 * has no readable documents. Each prediction carries the question, a
 * likelihood (high / medium / low), its topic and an answer outline.
 *
 * GET    /api/exam-prediction?email=<email>           → { ok, predictions }
 * POST   /api/exam-prediction { email, subjectId, lang? }
 *                                                     → { ok, prediction }
 * DELETE /api/exam-prediction?email=<email>&id=<id>   → { ok: true }
 */

export const runtime = 'nodejs';

/* AI generation can take well over the 10 s default — Vercel Hobby cap. */
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const LANG_NAMES: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  mr: 'Marathi',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
};

const STORED_RUNS = 50; // prediction runs listed per user
const MAX_CONTEXT_DOCS = 5;
const MAX_PREDICTIONS = 12; // hard clamp on stored predictions

const LIKELIHOODS = ['high', 'medium', 'low'] as const;
export type Likelihood = (typeof LIKELIHOODS)[number];

export type Prediction = {
  question: string;
  likelihood: Likelihood;
  topic: string;
  answerOutline: string;
};

export type PredictionRunDTO = {
  id: string;
  subjectId: string | null;
  subjectName: string;
  title: string;
  predictions: Prediction[];
  createdAt: string;
};

function coerceLikelihood(raw: unknown): Likelihood {
  return (LIKELIHOODS as readonly string[]).includes(
    typeof raw === 'string' ? raw.toLowerCase() : ''
  )
    ? (raw as Likelihood)
    : 'medium';
}

/* ── Shape one raw model prediction into a safe Prediction, or null ─ */
function coercePrediction(raw: unknown): Prediction | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const question =
    typeof p.question === 'string' ? p.question.trim().slice(0, 500) : '';
  if (!question) return null;
  const str = (v: unknown, cap: number) =>
    typeof v === 'string' ? v.trim().slice(0, cap) : '';
  return {
    question,
    likelihood: coerceLikelihood(p.likelihood),
    topic: str(p.topic, 120),
    answerOutline: str(p.answerOutline, 1200),
  };
}

/* ── Robust JSON extraction (same battle-tested stack as the other AI
   features: direct → repaired → fenced → sliced out of prose) ────── */
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

function asRunObj(parsed: unknown): Record<string, unknown> | null {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.predictions)) return obj;
  }
  return null;
}

function tryParseRun(candidate: string): Record<string, unknown> | null {
  const attempts = [candidate, repairJson(candidate)];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const parsed: unknown = JSON.parse(attempt);
      const direct = asRunObj(parsed);
      if (direct) return direct;
      /* Double-encoded: the reply is a JSON string literal wrapping the
         actual object — try the inner text (raw + repaired). */
      if (typeof parsed === 'string') {
        for (const inner of [parsed, repairJson(parsed)]) {
          if (!inner) continue;
          try {
            const obj = asRunObj(JSON.parse(inner));
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

function parseRun(
  raw: string
): { title: string; predictions: Prediction[] } | null {
  let obj = tryParseRun(raw.trim());
  if (!obj) {
    /* A fenced ```json block inside the reply. */
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) obj = tryParseRun(fence[1].trim());
  }
  if (!obj) {
    /* Prose around the JSON — slice from the first { to the last }. */
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      obj = tryParseRun(raw.slice(start, end + 1));
    }
  }
  if (!obj) return null;

  const predictions = (obj.predictions as unknown[])
    .map(coercePrediction)
    .filter((p): p is Prediction => p !== null);
  if (predictions.length === 0) return null;

  const title =
    typeof obj.title === 'string' && obj.title.trim()
      ? obj.title.trim().slice(0, 140)
      : '';
  return { title, predictions };
}

/* ── System prompt ─────────────────────────────────────────────────── */
function buildSystemPrompt(
  langName: string,
  subjectName: string,
  docContext: string | null
): string {
  const shape =
    'Respond with ONLY a valid JSON object — no markdown fences, no commentary — in exactly this shape:\n' +
    '{"title": string, "predictions": [{"question": string, "likelihood": "high"|"medium"|"low", "topic": string, "answerOutline": string}, ...]}\n' +
    '"title" is a short descriptive title for the prediction set. "likelihood" reflects how ' +
    'likely the question is to appear (high / medium / low). "topic" is the syllabus topic it ' +
    'belongs to. "answerOutline" is a 2-3 sentence outline of a strong answer. ' +
    'Plain text only — no markdown symbols.';

  const base =
    `You are Gyanzo's Exam Prediction engine, part of an AI study companion for students. ` +
    `Analyze the subject "${subjectName}"'s material and list the 8-10 exam questions MOST ` +
    `LIKELY to appear, mixing recall, explanation and application questions. ` +
    `Write everything in ${langName}.`;

  if (docContext) {
    return (
      `${base}\n\nUse the study material below as the primary source — weight the predictions ` +
      `toward what the material emphasizes.\n\nSTUDY MATERIAL:\n${docContext}\n\n${shape}`
    );
  }
  return (
    `${base}\n\nNo readable documents were found for this subject, so base the predictions on ` +
    `your general knowledge of the typical college syllabus and exams for "${subjectName}".\n\n${shape}`
  );
}

/* ── Shape a DB row for the client (predictions JSON parsed safely) ─ */
function serialize(row: {
  id: string;
  subjectId: string | null;
  subjectName: string;
  title: string;
  predictions: string;
  createdAt: Date;
}): PredictionRunDTO {
  let predictions: Prediction[] = [];
  try {
    const parsed = JSON.parse(row.predictions) as unknown;
    if (Array.isArray(parsed)) {
      predictions = parsed
        .map(coercePrediction)
        .filter((p): p is Prediction => p !== null);
    }
  } catch {
    /* keep the empty fallback */
  }
  return {
    id: row.id,
    subjectId: row.subjectId,
    subjectName: row.subjectName,
    title: row.title,
    predictions,
    createdAt: row.createdAt.toISOString(),
  };
}

/* ── GET → the user's saved prediction runs (newest first) ────────── */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    const rows = await db.examPrediction.findMany({
      where: { userEmail: email },
      orderBy: { createdAt: 'desc' },
      take: STORED_RUNS,
    });
    return NextResponse.json({
      ok: true,
      predictions: rows.map(serialize),
    });
  } catch (error) {
    console.error('[exam-prediction/GET] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/* ── POST → predict likely exam questions with the LLM and persist ── */
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

    /* Extracted PDF text is the primary source; general syllabus is the
       fallback when the subject has no readable documents. */
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
          content: buildSystemPrompt(langName, subject.name, docContext),
        },
        {
          role: 'user',
          content: `Predict the most likely exam questions for my subject "${subject.name}".`,
        },
      ],
      thinking: { type: 'disabled' },
    });

    const raw = completion.choices[0]?.message?.content ?? '';
    if (!raw.trim()) throw new Error('empty completion');
    const parsed = parseRun(raw);
    if (!parsed) {
      /* Don't persist garbage — surface the failure to the client. */
      throw new Error('unparseable exam-prediction reply');
    }

    const predictions = parsed.predictions.slice(0, MAX_PREDICTIONS);

    const row = await db.examPrediction.create({
      data: {
        userEmail: email,
        subjectId,
        subjectName: subject.name,
        title:
          parsed.title || `${subject.name} exam predictions`,
        predictions: JSON.stringify(predictions),
      },
    });

    return NextResponse.json({ ok: true, prediction: serialize(row) });
  } catch (error) {
    if (error instanceof AiNotConfiguredError) {
      console.error('[exam-prediction/POST] AI provider not configured on this host');
      return NextResponse.json(
        { ok: false, error: 'ai_not_configured' },
        { status: 503 }
      );
    }
    console.error('[exam-prediction/POST] ai error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/* ── DELETE → remove one saved prediction run ─────────────────────── */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();
  const id = (searchParams.get('id') ?? '').trim();

  if (!EMAIL_RE.test(email) || !id) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    await db.examPrediction.deleteMany({ where: { id, userEmail: email } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[exam-prediction/DELETE] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}
