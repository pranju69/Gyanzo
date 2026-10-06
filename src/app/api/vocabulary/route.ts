import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { AiNotConfiguredError, getAi } from '@/lib/ai-client';
import { createChatCompletion } from '@/lib/ai';
import { extractPdfText } from '@/lib/pdf-text';

/**
 * Vocabulary — AI-extracted key terms, scoped to the signed-in user's
 * email. A generation targets one of the user's subjects: the extracted
 * text of its uploaded PDFs is the primary source, with a general
 * knowledge fallback when the subject has no readable documents. Each
 * word carries term / pos / pronunciation (IPA) / definition / example.
 *
 * Known/Learning marks live in VocabProgress (one row per word, upserted
 * by /api/vocabulary/<id>/progress) and are merged into every GET.
 *
 * GET    /api/vocabulary?email=<email>              → { ok, lists }
 * POST   /api/vocabulary { email, subjectId, count, lang? }
 *                                                   → { ok, list }
 * DELETE /api/vocabulary?email=<email>&id=<id>      → { ok: true }
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

const STORED_LISTS = 50; // lists returned per user
const MAX_CONTEXT_DOCS = 5;

export type VocabWord = {
  term: string;
  pos: string;
  pronunciation: string;
  definition: string;
  example: string;
};

export type VocabListDTO = {
  id: string;
  subjectId: string | null;
  subjectName: string;
  count: number;
  words: VocabWord[];
  known: number[];
  createdAt: string;
};

/* ── Shape one raw model word into a safe VocabWord, or null ──────── */
function coerceWord(raw: unknown): VocabWord | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  const term =
    typeof w.term === 'string' ? w.term.trim().slice(0, 120) : '';
  if (!term) return null;
  const str = (v: unknown, cap: number) =>
    typeof v === 'string' ? v.trim().slice(0, cap) : '';
  return {
    term,
    pos: str(w.pos, 40),
    pronunciation: str(w.pronunciation, 80),
    definition: str(w.definition, 500),
    example: str(w.example, 400),
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

function asVocabObj(parsed: unknown): Record<string, unknown> | null {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.words)) return obj;
  }
  return null;
}

function tryParseVocab(candidate: string): Record<string, unknown> | null {
  const attempts = [candidate, repairJson(candidate)];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const parsed: unknown = JSON.parse(attempt);
      const direct = asVocabObj(parsed);
      if (direct) return direct;
      /* Double-encoded: the reply is a JSON string literal wrapping the
         actual object — try the inner text (raw + repaired). */
      if (typeof parsed === 'string') {
        for (const inner of [parsed, repairJson(parsed)]) {
          if (!inner) continue;
          try {
            const obj = asVocabObj(JSON.parse(inner));
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

function parseWords(raw: string): VocabWord[] | null {
  let obj = tryParseVocab(raw.trim());
  if (!obj) {
    /* A fenced ```json block inside the reply. */
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) obj = tryParseVocab(fence[1].trim());
  }
  if (!obj) {
    /* Prose around the JSON — slice from the first { to the last }. */
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      obj = tryParseVocab(raw.slice(start, end + 1));
    }
  }
  if (!obj) return null;

  /* Coerce, then de-duplicate terms (case-insensitive) so the list
     never studies the same word twice. */
  const seen = new Set<string>();
  const words: VocabWord[] = [];
  for (const rawWord of obj.words as unknown[]) {
    const word = coerceWord(rawWord);
    if (!word) continue;
    const key = word.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  return words.length > 0 ? words : null;
}

/* ── System prompt ─────────────────────────────────────────────────── */
function buildSystemPrompt(
  count: number,
  langName: string,
  subjectName: string,
  docContext: string | null
): string {
  const shape =
    'Respond with ONLY a valid JSON object — no markdown fences, no commentary — in exactly this shape:\n' +
    '{"words": [{"term": string, "pos": string, "pronunciation": string, "definition": string, "example": string}, ...]}\n' +
    `"pos" is the part of speech (noun, verb, adjective, adverb, phrase...). "pronunciation" is ` +
    `the IPA transcription and may be an empty string. "definition" is 1-2 learner-friendly ` +
    `sentences. "example" is one sentence using the term. Include exactly ${count} terms — ` +
    'no duplicates. Plain text only — no markdown symbols.';

  const base =
    `You are the Vocabulary engine of Gyanzo, an AI study companion for students. ` +
    `Extract the ${count} most useful academic vocabulary terms from the subject ` +
    `"${subjectName}"'s material. Write everything in ${langName}.`;

  if (docContext) {
    return (
      `${base}\n\nUse the study material below as the primary source — pick terms that actually ` +
      `appear in it or are essential to understanding it.\n\nSTUDY MATERIAL:\n${docContext}\n\n${shape}`
    );
  }
  return (
    `${base}\n\nNo readable documents were found for this subject, so pick the terms from your ` +
    `general knowledge of the typical college syllabus for "${subjectName}".\n\n${shape}`
  );
}

/* ── Shape a DB row for the client (words JSON parsed safely) ─────── */
function serialize(
  row: {
    id: string;
    subjectId: string | null;
    subjectName: string;
    count: number;
    words: string;
    createdAt: Date;
  },
  known: number[]
): VocabListDTO {
  let words: VocabWord[] = [];
  try {
    const parsed = JSON.parse(row.words) as unknown;
    if (Array.isArray(parsed)) {
      words = parsed
        .map(coerceWord)
        .filter((w): w is VocabWord => w !== null);
    }
  } catch {
    /* keep the empty fallback */
  }
  return {
    id: row.id,
    subjectId: row.subjectId,
    subjectName: row.subjectName,
    count: row.count,
    words,
    known,
    createdAt: row.createdAt.toISOString(),
  };
}

/* ── GET → the user's saved word lists (newest first) ─────────────── */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    const rows = await db.vocabList.findMany({
      where: { userEmail: email },
      orderBy: { createdAt: 'desc' },
      take: STORED_LISTS,
    });

    /* Known word indices per list, merged from the progress table. */
    const marks = await db.vocabProgress.findMany({
      where: { userEmail: email, known: true },
      select: { listId: true, wordIdx: true },
    });
    const knownByList = new Map<string, number[]>();
    for (const m of marks) {
      const arr = knownByList.get(m.listId);
      if (arr) arr.push(m.wordIdx);
      else knownByList.set(m.listId, [m.wordIdx]);
    }

    const lists = rows.map((row) => {
      const known = (knownByList.get(row.id) ?? []).sort((a, b) => a - b);
      return serialize(row, known);
    });
    return NextResponse.json({ ok: true, lists });
  } catch (error) {
    console.error('[vocabulary/GET] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/* ── POST → extract vocabulary terms with the LLM and persist them ── */
export async function POST(request: Request) {
  let body: {
    email?: unknown;
    subjectId?: unknown;
    count?: unknown;
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
    24,
    Math.max(4, Math.round(Number(body.count) || 12))
  );
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
          content: buildSystemPrompt(
            count,
            langName,
            subject.name,
            docContext
          ),
        },
        {
          role: 'user',
          content: `Build a vocabulary list of ${count} key terms for my subject "${subject.name}".`,
        },
      ],
      thinking: { type: 'disabled' },
    });

    const raw = completion.choices[0]?.message?.content ?? '';
    if (!raw.trim()) throw new Error('empty completion');
    const parsed = parseWords(raw);
    if (!parsed) throw new Error('unparseable vocabulary reply');

    /* Tolerate a small overshoot (count + 2), then clamp to count. */
    const words = parsed.slice(0, count + 2).slice(0, count);

    const row = await db.vocabList.create({
      data: {
        userEmail: email,
        subjectId,
        subjectName: subject.name,
        count: words.length,
        words: JSON.stringify(words),
      },
    });

    return NextResponse.json({
      ok: true,
      list: serialize(row, []),
    });
  } catch (error) {
    if (error instanceof AiNotConfiguredError) {
      console.error('[vocabulary/POST] AI provider not configured on this host');
      return NextResponse.json(
        { ok: false, error: 'ai_not_configured' },
        { status: 503 }
      );
    }
    console.error('[vocabulary/POST] ai error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/* ── DELETE → remove one word list and its progress marks ─────────── */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();
  const id = (searchParams.get('id') ?? '').trim();

  if (!EMAIL_RE.test(email) || !id) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    await db.vocabList.deleteMany({ where: { id, userEmail: email } });
    await db.vocabProgress.deleteMany({
      where: { listId: id, userEmail: email },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[vocabulary/DELETE] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}
