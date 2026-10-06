import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { AiNotConfiguredError, getAi } from '@/lib/ai-client';
import { createChatCompletion } from '@/lib/ai';
import { extractPdfText } from '@/lib/pdf-text';

/**
 * Easy Explanation — AI-generated topic explanations ("Topic Explainer"),
 * scoped to the signed-in user's email. A generation targets one free-text
 * topic; optionally a subject can be selected as context, in which case the
 * extracted text of that subject's uploaded PDFs is the primary source.
 *
 * GET    /api/explanations?email=<email>          → { ok, explanations }
 * POST   /api/explanations { email, topic, subjectId?, style, lang? }
 *          → { ok, explanation }
 * DELETE /api/explanations?email=<email>&id=<id>  → { ok }
 */

export const runtime = 'nodejs';

/* AI generation can take well over the 10 s default — Vercel Hobby cap. */
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STORED_EXPLANATIONS = 50;
const MAX_TOPIC_CHARS = 200;

const STYLES = ['teacher', 'kid', 'examples', 'steps'] as const;
type StyleId = (typeof STYLES)[number];

/* Per-style teaching instructions for the model */
const STYLE_SPEC: Record<StyleId, string> = {
  teacher:
    'Explain like a friendly, experienced teacher: build up from the fundamentals, define every piece of jargon the moment it appears, keep a warm instructional tone, and make the structure crystal clear.',
  kid:
    'Explain it so a 10-year-old can understand: use very simple everyday words, short sentences, playful analogies from daily life (games, food, school, animals), and zero unexplained jargon.',
  examples:
    'Explain through concrete worked examples: every concept must be grounded with at least one real-world example or mini scenario, clearly labeled, so the idea becomes tangible.',
  steps:
    'Explain as an ordered step-by-step walkthrough: break the topic into numbered stages, and for each stage say what happens and why it matters, so the reader can follow the whole process end to end.',
};

const LANG_NAMES: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  mr: 'Marathi',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
};

type ExplanationContent = {
  intro: string;
  sections: { heading: string; text: string }[];
  takeaways: string[];
};

type ExplanationDTO = {
  id: string;
  topic: string;
  subjectId: string | null;
  subjectName: string;
  style: string;
  title: string;
  content: ExplanationContent;
  createdAt: string;
};

/* ── Shape a DB row for the client (content JSON parsed safely) ── */
function serialize(row: {
  id: string;
  topic: string;
  subjectId: string | null;
  subjectName: string;
  style: string;
  title: string;
  content: string;
  createdAt: Date;
}): ExplanationDTO {
  let content: ExplanationContent = { intro: '', sections: [], takeaways: [] };
  try {
    const parsed = JSON.parse(row.content) as ExplanationContent;
    if (parsed && typeof parsed === 'object') {
      content = {
        intro: typeof parsed.intro === 'string' ? parsed.intro : '',
        sections: Array.isArray(parsed.sections)
          ? parsed.sections.map((s) => ({
              heading: typeof s?.heading === 'string' ? s.heading : '',
              text: typeof s?.text === 'string' ? s.text : '',
            }))
          : [],
        takeaways: Array.isArray(parsed.takeaways)
          ? parsed.takeaways.map(String)
          : [],
      };
    }
  } catch {
    /* keep the empty fallback */
  }
  return {
    id: row.id,
    topic: row.topic,
    subjectId: row.subjectId,
    subjectName: row.subjectName,
    style: row.style,
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

function asExplanationObj(parsed: unknown): Record<string, unknown> | null {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.sections) || typeof obj.intro === 'string') {
      return obj;
    }
  }
  return null;
}

/* Try to parse a candidate as the explanation JSON object. Handles replies
   that are double-encoded as a JSON string literal (the model's habit),
   fenced markdown, JSON embedded in prose, or slightly broken JSON. */
function tryParseExplanation(
  candidate: string
): Record<string, unknown> | null {
  const attempts = [candidate, repairJson(candidate)];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const parsed: unknown = JSON.parse(attempt);
      const direct = asExplanationObj(parsed);
      if (direct) return direct;
      /* Double-encoded: the reply is a JSON string literal wrapping the
         actual object — try the inner text (raw + repaired). */
      if (typeof parsed === 'string') {
        for (const inner of [parsed, repairJson(parsed)]) {
          if (!inner) continue;
          try {
            const obj = asExplanationObj(JSON.parse(inner));
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
): { title: string; content: ExplanationContent } {
  /* 1) The reply as-is (covers double-encoded string replies). */
  let obj = tryParseExplanation(raw.trim());
  /* 2) A fenced ```json block inside the reply. */
  if (!obj) {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) obj = tryParseExplanation(fence[1].trim());
  }
  /* 3) Prose around the JSON — slice from the first { to the last }. */
  if (!obj) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      obj = tryParseExplanation(raw.slice(start, end + 1));
    }
  }

  if (obj) {
    const sections = Array.isArray(obj.sections) ? obj.sections : [];
    const content: ExplanationContent = {
      intro: typeof obj.intro === 'string' ? obj.intro.trim() : '',
      sections: sections
        .map((s) => {
          const sec = (s ?? {}) as Record<string, unknown>;
          return {
            heading:
              typeof sec.heading === 'string' ? sec.heading.trim() : '',
            text: typeof sec.text === 'string' ? sec.text.trim() : '',
          };
        })
        .filter((s) => s.heading || s.text),
      takeaways: Array.isArray(obj.takeaways)
        ? obj.takeaways
            .map((k) => String(k).replace(/^[-•*]\s*/, '').trim())
            .filter(Boolean)
        : [],
    };
    if (
      content.intro ||
      content.sections.length > 0 ||
      content.takeaways.length > 0
    ) {
      const title =
        typeof obj.title === 'string' && obj.title.trim()
          ? obj.title.trim()
          : fallbackTitle;
      return { title, content };
    }
  }

  // Fallback: treat the whole reply as one heading-less prose section.
  const text = raw.trim();
  return {
    title: fallbackTitle,
    content: {
      intro: '',
      sections: text ? [{ heading: '', text }] : [],
      takeaways: [],
    },
  };
}

/* ── System prompt ─────────────────────────────────────────────────── */
function buildSystemPrompt(
  topic: string,
  style: StyleId,
  langName: string,
  subjectName: string | null,
  docContext: string | null
): string {
  const shape =
    'Respond with ONLY a valid JSON object — no markdown fences, no commentary — in exactly this shape:\n' +
    '{"title": string, "intro": string, "sections": [{"heading": string, "text": string}, ...], "takeaways": [string, ...]}\n' +
    '"title" is a short descriptive title for the explanation. "intro" is a 1-3 sentence hook paragraph. ' +
    '"sections" contains 3-6 entries; each "heading" is a short section title and each "text" is a flowing ' +
    '3-6 sentence paragraph (plain text — no markdown symbols, no leading dashes, no numbered lists unless ' +
    'the style requires them). "takeaways" contains 3-5 short, memorable key points.';

  const base =
    `You are the Easy Explanation engine of Gyanzo, an AI study companion for students. ` +
    `Explain the topic "${topic}" clearly. ${STYLE_SPEC[style]} ` +
    `Write the entire explanation in ${langName}.`;

  if (subjectName && docContext) {
    return (
      `${base}\n\nThe student picked "${subjectName}" as the subject context. Use the study material ` +
      `below as the primary source — ground the explanation in it faithfully, filling gaps with your ` +
      `general knowledge only where needed.\n\nSTUDY MATERIAL:\n${docContext}\n\n${shape}`
    );
  }
  return (
    `${base}\n\nNo subject context was selected, so explain from your general knowledge.\n\n${shape}`
  );
}

/* ── GET → the user's saved explanations (newest first) ───────────── */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    const rows = await db.explanation.findMany({
      where: { userEmail: email },
      orderBy: { createdAt: 'desc' },
      take: STORED_EXPLANATIONS,
    });
    return NextResponse.json({
      ok: true,
      explanations: rows.map(serialize),
    });
  } catch (error) {
    console.error('[explanations/GET] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/* ── POST → generate an explanation with the LLM and persist it ───── */
export async function POST(request: Request) {
  let body: {
    email?: unknown;
    topic?: unknown;
    subjectId?: unknown;
    style?: unknown;
    lang?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  const email =
    typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const topic =
    typeof body.topic === 'string'
      ? body.topic.trim().slice(0, MAX_TOPIC_CHARS)
      : '';
  const subjectId =
    typeof body.subjectId === 'string' ? body.subjectId.trim() : '';
  const style: StyleId = (STYLES as readonly string[]).includes(
    typeof body.style === 'string' ? body.style : ''
  )
    ? (body.style as StyleId)
    : 'teacher';
  const langName =
    LANG_NAMES[typeof body.lang === 'string' ? body.lang : 'en'] ?? 'English';

  if (!EMAIL_RE.test(email) || !topic) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    /* Optional subject context (must belong to this user) */
    let subjectName: string | null = null;
    let docContext: string | null = null;
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
          docContext = await extractPdfText(docs);
        }
      }
    }

    const zai = await getAi();
    const completion = await createChatCompletion(zai, {
      messages: [
        {
          role: 'assistant',
          content: buildSystemPrompt(
            topic,
            style,
            langName,
            subjectName,
            docContext
          ),
        },
        {
          role: 'user',
          content: `Explain the topic "${topic}" (${style} style).`,
        },
      ],
      thinking: { type: 'disabled' },
    });

    const raw = completion.choices[0]?.message?.content ?? '';
    if (!raw.trim()) throw new Error('empty completion');
    const { title, content } = parseContent(raw, topic);

    const row = await db.explanation.create({
      data: {
        userEmail: email,
        topic,
        subjectId: subjectName ? subjectId : null,
        subjectName: subjectName ?? '',
        style,
        title,
        content: JSON.stringify(content),
      },
    });

    return NextResponse.json({ ok: true, explanation: serialize(row) });
  } catch (error) {
    if (error instanceof AiNotConfiguredError) {
      console.error('[explanations/POST] AI provider not configured on this host');
      return NextResponse.json(
        { ok: false, error: 'ai_not_configured' },
        { status: 503 }
      );
    }
    console.error('[explanations/POST] ai error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/* ── DELETE → remove one saved explanation ────────────────────────── */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();
  const id = (searchParams.get('id') ?? '').trim();

  if (!EMAIL_RE.test(email) || !id) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    await db.explanation.deleteMany({ where: { id, userEmail: email } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[explanations/DELETE] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}
