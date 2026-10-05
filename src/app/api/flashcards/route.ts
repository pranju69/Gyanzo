import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import ZAI from 'z-ai-web-dev-sdk';
import { createChatCompletion } from '@/lib/ai';
import { extractPdfSource } from '@/lib/pdf-text';
import { pushNotification } from '@/lib/notify';

/**
 * Flashcards — AI-generated study decks, scoped to the signed-in user's
 * email. A generation targets the user's chosen subject (or general
 * study material when no subject is selected) and a card count.
 *
 * GET  /api/flashcards?email=<email>          → { ok, decks: DeckDTO[] }
 * POST /api/flashcards { email, subjectId?, count, lang? }
 *                                              → { ok, deck: DeckFull }
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

export type FlashCard = { front: string; back: string };

export type DeckDTO = {
  id: string;
  subjectId: string | null;
  subjectName: string;
  title: string;
  total: number;
  knownCount: number;
  createdAt: string;
};

export type DeckFull = DeckDTO & { cards: FlashCard[]; known: number[] };

/* Turn one raw model card into a safe FlashCard, or null if unusable. */
function coerceCard(raw: unknown): FlashCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const front = typeof c.front === 'string' ? c.front.trim().slice(0, 400) : '';
  const back = typeof c.back === 'string' ? c.back.trim().slice(0, 900) : '';
  if (!front || !back || front === back) return null;
  return { front, back };
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

function asDeckObj(parsed: unknown): Record<string, unknown> | null {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.cards)) return obj;
  }
  return null;
}

function tryParseDeck(candidate: string): Record<string, unknown> | null {
  const attempts = [candidate, repairJson(candidate)];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const parsed: unknown = JSON.parse(attempt);
      const direct = asDeckObj(parsed);
      if (direct) return direct;
      if (typeof parsed === 'string') {
        for (const inner of [parsed, repairJson(parsed)]) {
          if (!inner) continue;
          try {
            const obj = asDeckObj(JSON.parse(inner));
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

function parseDeck(raw: string): { title: string; cards: FlashCard[] } | null {
  let obj = tryParseDeck(raw.trim());
  if (!obj) {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) obj = tryParseDeck(fence[1].trim());
  }
  if (!obj) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      obj = tryParseDeck(raw.slice(start, end + 1));
    }
  }
  if (!obj) return null;

  /* Coerce, then de-duplicate fronts (case-insensitive) so the deck
     never studies the same card twice. */
  const seen = new Set<string>();
  const cards: FlashCard[] = [];
  for (const rawCard of obj.cards as unknown[]) {
    const card = coerceCard(rawCard);
    if (!card) continue;
    const key = card.front.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push(card);
  }
  if (cards.length === 0) return null;

  const title =
    typeof obj.title === 'string' && obj.title.trim()
      ? obj.title.trim().slice(0, 120)
      : '';
  return { title, cards };
}

/* ── System prompt ─────────────────────────────────────────────────── */
function buildSystemPrompt(
  count: number,
  langName: string,
  subjectName: string | null,
  docContext: string | null
): string {
  const shape =
    'Respond with ONLY a valid JSON object — no markdown fences, no commentary — in exactly this shape:\n' +
    '{"title": string, "cards": [{"front": string, "back": string}, ...]}\n' +
    `"title" is a short deck title (2-5 words). Include exactly ${count} cards. ` +
    'Each "front" is a short question, key term or concept prompt; each "back" is a ' +
    'concise answer or definition (one or two sentences, max ~40 words). ' +
    'Plain text only — no markdown symbols in fronts or backs.';

  const base =
    `You are the Flashcards engine of Gyanzo, an AI study companion for students. ` +
    `Create a deck with exactly ${count} flashcards for spaced-repetition study. ` +
    `Write everything in ${langName}.`;

  if (subjectName && docContext) {
    return (
      `${base}\n\nThe student picked "${subjectName}" as the subject and uploaded study material for it. ` +
      `Base EVERY card on the study material below — fronts and backs must be answerable from it alone. ` +
      `Quote its exact terms, names and figures. Do NOT invent facts that are not in the material.\n\nSTUDY MATERIAL:\n${docContext}\n\n${shape}`
    );
  }
  if (subjectName) {
    return (
      `${base}\n\nThe student picked "${subjectName}" as the subject. No readable documents were ` +
      `found for it, so write the cards from your general knowledge of "${subjectName}" ` +
      `at a level appropriate for students.\n\n${shape}`
    );
  }
  return (
    `${base}\n\nNo subject was selected, so write the cards from general academic study material ` +
    `(a friendly mix of science, history, geography, math and language) at a level appropriate ` +
    `for students.\n\n${shape}`
  );
}

/* ── GET → list the user's decks with mastery counts ──────────────── */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    const decks = await db.flashcardDeck.findMany({
      where: { userEmail: email },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        subjectId: true,
        subjectName: true,
        title: true,
        cards: true,
        createdAt: true,
      },
    });
    const knownRows = await db.flashcardProgress.groupBy({
      by: ['deckId'],
      where: { userEmail: email, known: true },
      _count: { deckId: true },
    });
    const knownByDeck = new Map<string, number>();
    for (const row of knownRows) knownByDeck.set(row.deckId, row._count.deckId);

    const list: DeckDTO[] = decks.map((row) => {
      let total = 0;
      try {
        const parsed = JSON.parse(row.cards) as unknown;
        if (Array.isArray(parsed)) total = parsed.length;
      } catch {
        total = 0;
      }
      return {
        id: row.id,
        subjectId: row.subjectId,
        subjectName: row.subjectName,
        title: row.title,
        total,
        knownCount: knownByDeck.get(row.id) ?? 0,
        createdAt: row.createdAt.toISOString(),
      };
    });
    return NextResponse.json({ ok: true, decks: list });
  } catch (error) {
    console.error('[flashcards/GET] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/* ── POST → generate a deck with the LLM and persist it ───────────── */
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

  if (!EMAIL_RE.test(email)) {
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

    const zai = await ZAI.create();
    const completion = await createChatCompletion(zai, {
      messages: [
        {
          role: 'assistant',
          content: buildSystemPrompt(count, langName, subjectName, docContext),
        },
        {
          role: 'user',
          content: `Generate a deck of ${count} flashcards${
            subjectName ? ` about ${subjectName}` : ''
          }.`,
        },
      ],
      thinking: { type: 'disabled' },
    });

    const raw = completion.choices[0]?.message?.content ?? '';
    if (!raw.trim()) throw new Error('empty completion');
    const parsed = parseDeck(raw);
    if (!parsed) throw new Error('unparseable flashcards reply');

    const cards = parsed.cards.slice(0, count);

    /* Source transparency — which uploaded PDFs actually fed the deck */
    const sourcePayload =
      subjectName && source
        ? {
            kind: docContext ? ('pdf' as const) : ('unreadable' as const),
            used: source.used,
            unreadable: source.unreadable,
          }
        : null;

    const row = await db.flashcardDeck.create({
      data: {
        userEmail: email,
        subjectId: subjectName ? subjectId : null,
        subjectName: subjectName ?? '',
        title:
          parsed.title ||
          (subjectName ? `${subjectName} flashcards` : 'Study flashcards'),
        cards: JSON.stringify(cards),
      },
    });

    /* Real-time bell notification (persist + socket fan-out). */
    void pushNotification({
      email,
      type: 'flashcards',
      params: {
        count: cards.length,
        subject: subjectName ?? '',
        title: row.title,
      },
      actionNav: 'flashcards',
    });

    const deck: DeckFull = {
      id: row.id,
      subjectId: row.subjectId,
      subjectName: row.subjectName,
      title: row.title,
      total: cards.length,
      knownCount: 0,
      cards,
      known: [],
      createdAt: row.createdAt.toISOString(),
    };
    return NextResponse.json({ ok: true, deck, source: sourcePayload });
  } catch (error) {
    console.error('[flashcards/POST] ai error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}
