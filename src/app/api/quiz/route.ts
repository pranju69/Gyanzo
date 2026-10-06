import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { AiNotConfiguredError, getAi } from '@/lib/ai-client';
import { createChatCompletion } from '@/lib/ai';
import { extractPdfSource } from '@/lib/pdf-text';

/**
 * Quiz — AI-generated quizzes, scoped to the signed-in user's email.
 * A generation targets the user's chosen subject (or general knowledge
 * when no subject is selected), a question count, a set of question
 * types (mcq / truefalse / fillblank) and a difficulty level.
 *
 * POST /api/quiz { email, subjectId?, count, types, difficulty, lang? }
 *   → { ok, quiz }
 */

export const runtime = 'nodejs';

/* AI generation can take well over the 10 s default — Vercel Hobby cap. */
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
type Difficulty = (typeof DIFFICULTIES)[number];

const QUESTION_TYPES = ['mcq', 'truefalse', 'fillblank'] as const;
type QType = (typeof QUESTION_TYPES)[number];

const LANG_NAMES: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  mr: 'Marathi',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
};

type QuizQuestion = {
  type: QType;
  question: string;
  options: string[] | null;
  answer: number | string;
  explanation: string;
};

type QuizDTO = {
  id: string;
  subjectId: string | null;
  subjectName: string;
  difficulty: string;
  title: string;
  count: number;
  questions: QuizQuestion[];
  createdAt: string;
};

/* ── Normalize the model's type naming into our ids ───────────────── */
function normType(raw: unknown): QType | null {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (s === 'mcq' || s === 'multiplechoice' || s === 'choice') return 'mcq';
  if (s === 'truefalse' || s === 'tf' || s === 'trueorfalse') return 'truefalse';
  if (
    s === 'fillblank' ||
    s === 'fillintheblank' ||
    s === 'fillintheblanks' ||
    s === 'fill' ||
    s === 'blank'
  )
    return 'fillblank';
  return null;
}

/* Turn one raw model question into a safe QuizQuestion, or null if it
   is unusable (missing text, out-of-range answer, empty options…). */
function coerceQuestion(raw: unknown): QuizQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const q = raw as Record<string, unknown>;
  const type = normType(q.type) ?? (Array.isArray(q.options) ? 'mcq' : null);
  if (!type) return null;
  const question = typeof q.question === 'string' ? q.question.trim() : '';
  if (!question) return null;

  const explanation =
    typeof q.explanation === 'string' ? q.explanation.trim() : '';

  if (type === 'mcq') {
    if (!Array.isArray(q.options)) return null;
    const options = q.options
      .map((o) => String(o ?? '').trim())
      .filter(Boolean);
    if (options.length < 2) return null;
    let answer = -1;
    if (typeof q.answer === 'number' && Number.isInteger(q.answer)) {
      answer = q.answer;
    } else if (typeof q.answer === 'string') {
      const trimmed = q.answer.trim();
      if (/^\d+$/.test(trimmed)) {
        answer = parseInt(trimmed, 10);
      } else {
        // The model put the answer TEXT into `answer` — find its index.
        answer = options.findIndex(
          (o) => o.toLowerCase() === trimmed.toLowerCase()
        );
      }
    }
    if (answer < 0 || answer >= options.length) return null;
    return { type, question, options, answer, explanation };
  }

  if (type === 'truefalse') {
    let answer: number;
    if (typeof q.answer === 'boolean') answer = q.answer ? 0 : 1;
    else if (typeof q.answer === 'number') answer = q.answer >= 0.5 ? 1 : 0;
    else {
      const s = String(q.answer ?? '')
        .trim()
        .toLowerCase();
      if (['0', 'true', 'false'].includes(s)) answer = s === 'false' ? 1 : 0;
      else if (['1', 'yes'].includes(s)) answer = 1;
      else return null;
    }
    return { type, question, options: null, answer, explanation };
  }

  // fillblank — "answer" is the accepted word/phrase ("a|b" = variants).
  if (typeof q.answer !== 'string' && typeof q.answer !== 'number')
    return null;
  const answer = String(q.answer).trim();
  if (!answer) return null;
  return { type, question, options: null, answer, explanation };
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
        out += stack.pop();
      }
      continue;
    }
    out += ch;
  }
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, '');
  return out + stack.reverse().join('');
}

function asQuizObj(parsed: unknown): Record<string, unknown> | null {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.questions)) return obj;
  }
  return null;
}

function tryParseQuiz(candidate: string): Record<string, unknown> | null {
  const attempts = [candidate, repairJson(candidate)];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const parsed: unknown = JSON.parse(attempt);
      const direct = asQuizObj(parsed);
      if (direct) return direct;
      if (typeof parsed === 'string') {
        for (const inner of [parsed, repairJson(parsed)]) {
          if (!inner) continue;
          try {
            const obj = asQuizObj(JSON.parse(inner));
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

function parseQuiz(
  raw: string
): { title: string; questions: QuizQuestion[] } | null {
  let obj = tryParseQuiz(raw.trim());
  if (!obj) {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) obj = tryParseQuiz(fence[1].trim());
  }
  if (!obj) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      obj = tryParseQuiz(raw.slice(start, end + 1));
    }
  }
  if (!obj) return null;

  const questions = (obj.questions as unknown[])
    .map(coerceQuestion)
    .filter((q): q is QuizQuestion => q !== null);
  if (questions.length === 0) return null;

  const title =
    typeof obj.title === 'string' && obj.title.trim()
      ? obj.title.trim()
      : '';
  return { title, questions };
}

/* ── System prompt ─────────────────────────────────────────────────── */
function buildSystemPrompt(
  count: number,
  types: QType[],
  difficulty: Difficulty,
  langName: string,
  subjectName: string | null,
  docContext: string | null
): string {
  const typeSpec =
    '- "mcq": exactly 4 short "options"; "answer" is the 0-based index of the single correct option.\n' +
    '- "truefalse": a statement-style question; "answer" is 0 for true or 1 for false; do NOT include "options".\n' +
    '- "fillblank": the question text must contain "___" marking the blank; "answer" is the correct word or short phrase (use "alt1|alt2" for acceptable variants); do NOT include "options".\n';

  const rotation =
    types.length === 1
      ? `All ${count} questions are of type "${types[0]}".`
      : `Rotate the types evenly through this repeating order: ${types.join(' → ')}.`;

  const difficultySpec =
    difficulty === 'easy'
      ? 'Difficulty "easy": direct recall of clearly stated facts, no tricks.'
      : difficulty === 'hard'
        ? 'Difficulty "hard": multi-step reasoning, analysis and plausible distractors.'
        : 'Difficulty "medium": understanding and application of the material.';

  const shape =
    'Respond with ONLY a valid JSON object — no markdown fences, no commentary — in exactly this shape:\n' +
    '{"title": string, "questions": [{"type": "mcq", "question": string, "options": ["...","...","...","..."], "answer": 0, "explanation": string}, ...]}\n' +
    '"title" is a short quiz title. Include exactly ' +
    `${count} questions. Every question gets a one-sentence "explanation" for its answer. ` +
    'Plain text only — no markdown symbols in questions or options.';

  const base =
    `You are the Quiz engine of Gyanzo, an AI study companion for students. ` +
    `Create a quiz with exactly ${count} questions. ${rotation} ${difficultySpec} ` +
    `Write all questions, options and answers in ${langName}.`;

  if (subjectName && docContext) {
    return (
      `${base}\n\nThe student picked "${subjectName}" as the subject and uploaded study material for it. ` +
      `Base EVERY question on the study material below — each question must be answerable from it alone. ` +
      `Quote its exact terms, names and figures. Do NOT invent facts that are not in the material.\n\nSTUDY MATERIAL:\n${docContext}\n\nTYPE SPEC:\n${typeSpec}\n${shape}`
    );
  }
  if (subjectName) {
    return (
      `${base}\n\nThe student picked "${subjectName}" as the subject. No readable documents were ` +
      `found for it, so write the questions from your general knowledge of "${subjectName}" ` +
      `at a level appropriate for students.\n\nTYPE SPEC:\n${typeSpec}\n${shape}`
    );
  }
  return (
    `${base}\n\nNo subject was selected, so write the questions from general academic knowledge ` +
    `(a friendly mix of science, history, geography, math and language) at a level appropriate ` +
    `for students.\n\nTYPE SPEC:\n${typeSpec}\n${shape}`
  );
}

/* ── POST → generate a quiz with the LLM and persist it ───────────── */
export async function POST(request: Request) {
  let body: {
    email?: unknown;
    subjectId?: unknown;
    count?: unknown;
    types?: unknown;
    difficulty?: unknown;
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
  const count = Math.min(
    20,
    Math.max(3, Math.round(Number(body.count) || 8))
  );
  const types = (Array.isArray(body.types) ? body.types : []).filter(
    (t): t is QType =>
      (QUESTION_TYPES as readonly string[]).includes(String(t))
  );
  const difficulty: Difficulty = (DIFFICULTIES as readonly string[]).includes(
    typeof body.difficulty === 'string' ? body.difficulty : ''
  )
    ? (body.difficulty as Difficulty)
    : 'medium';
  const langName =
    LANG_NAMES[typeof body.lang === 'string' ? body.lang : 'en'] ?? 'English';

  if (!EMAIL_RE.test(email) || types.length === 0) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    /* Optional subject context (must belong to this user) */
    let subjectName: string | null = null;
    let docContext: string | null = null;
    let source: { used: string[]; unreadable: string[] } | null = null;
    if (subjectId) {
      const subject = await db.subject.findFirst({
        where: { id: subjectId, userEmail: email },
        select: { name: true },
      });
      if (subject) {
        subjectName = subject.name;
        const docs = await db.pdf.findMany({
          where: { userEmail: email, subjectName: subject.name },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { name: true, storedAs: true, blobUrl: true },
        });
        if (docs.length > 0) {
          const extracted = await extractPdfSource(docs, {
            perDocChars: 12000,
            totalChars: 36000,
          });
          docContext = extracted.context;
          source = { used: extracted.used, unreadable: extracted.unreadable };
        }
      }
    }

    const zai = await getAi();
    const completion = await createChatCompletion(zai, {
      messages: [
        {
          role: 'assistant',
          content: buildSystemPrompt(
            count,
            types,
            difficulty,
            langName,
            subjectName,
            docContext
          ),
        },
        {
          role: 'user',
          content: `Generate a ${count}-question ${difficulty} quiz${
            subjectName ? ` about ${subjectName}` : ''
          }.`,
        },
      ],
      thinking: { type: 'disabled' },
    });

    const raw = completion.choices[0]?.message?.content ?? '';
    if (!raw.trim()) throw new Error('empty completion');
    const parsed = parseQuiz(raw);
    if (!parsed) throw new Error('unparseable quiz reply');

    const questions = parsed.questions.slice(0, count);

    /* Source transparency — which uploaded PDFs actually fed the quiz */
    const sourcePayload =
      subjectName && source
        ? {
            kind: docContext ? ('pdf' as const) : ('unreadable' as const),
            used: source.used,
            unreadable: source.unreadable,
          }
        : null;

    const row = await db.quiz.create({
      data: {
        userEmail: email,
        subjectId: subjectName ? subjectId : null,
        subjectName: subjectName ?? '',
        difficulty,
        types: JSON.stringify(types),
        title:
          parsed.title ||
          (subjectName ? `${subjectName} quiz` : 'Study quiz'),
        questions: JSON.stringify(questions),
      },
    });

    const quiz: QuizDTO = {
      id: row.id,
      subjectId: row.subjectId,
      subjectName: row.subjectName,
      difficulty: row.difficulty,
      title: row.title,
      count: questions.length,
      questions,
      createdAt: row.createdAt.toISOString(),
    };
    return NextResponse.json({ ok: true, quiz, source: sourcePayload });
  } catch (error) {
    if (error instanceof AiNotConfiguredError) {
      console.error('[quiz/POST] AI provider not configured on this host');
      return NextResponse.json(
        { ok: false, error: 'ai_not_configured' },
        { status: 503 }
      );
    }
    console.error('[quiz/POST] ai error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}
