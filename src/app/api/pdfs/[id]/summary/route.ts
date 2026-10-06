import { db } from '@/lib/db';
import { loadPdfBytes } from '@/lib/pdf-store';
import { createChatCompletion, AiRateLimitError } from '@/lib/ai';
import ZAI from 'z-ai-web-dev-sdk';
import { extractText, getDocumentProxy } from 'unpdf';

/**
 * AI page-by-page summary for ONE uploaded PDF (PDF Library "eye" dialog).
 *
 * GET /api/pdfs/<id>/summary?email=<email>  →  text/event-stream
 *
 * Events (data: JSON lines):
 *   { type: 'meta',  total }                    — real page count of the PDF
 *   { type: 'page',  page, total, text }        — one page summarised
 *   { type: 'end',   done }                     — stream finished (done = all pages)
 *   { type: 'error', error }                    — fatal server error
 *     error: 'missing'  — the stored PDF binary no longer exists on disk
 *     error: 'corrupt'  — the stored file is not a readable PDF
 *     error: 'server'   — unexpected server failure
 *
 * Resilience rules:
 *   · The client can disconnect at any moment (Stop button) — progress is
 *     persisted in the PdfSummary table after EVERY page, so reconnecting
 *     replays the cached pages instantly and continues where it stopped.
 *   · A transient LLM failure on one page is retried by the shared helper
 *     (exponential backoff); if it still fails the page is stored as the
 *     [[PAGE_FAILED]] sentinel and the run CONTINUES — one flaky page never
 *     kills a long summary.
 *   · If the shared LLM quota is exhausted (429) on MAX_RATE_LIMIT_STRIKES
 *     consecutive pages, the run stops cleanly with a 'rate_limited' event
 *     instead of burning more quota — progress is persisted, so Resume
 *     continues where it stopped.
 *   · Unreadable pages (scanned/blank) are stored as the [[NO_TEXT]]
 *     sentinel and localised client-side.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_PAGE_CHARS = 4000; // page text fed to the model
const MAX_PAGES = 300; // hard safety cap on summarised pages
const MAX_RATE_LIMIT_STRIKES = 3; // consecutive rate-limited pages before stopping
const INTER_PAGE_DELAY_MS = 300; // be a good citizen of the shared LLM quota

const NO_TEXT = '[[NO_TEXT]]';
const PAGE_FAILED = '[[PAGE_FAILED]]';

type CachedPage = { page: number; text: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildPagePrompt(pageText: string, pdfName: string): string {
  return (
    `You are the AI study-summary engine of Gyanzo, an AI study companion for students. ` +
    `Summarize ONE page of the student's PDF "${pdfName}" as compact study notes.\n\n` +
    `Write the summary in the SAME language as the page text.\n\n` +
    `Format your reply EXACTLY like this (plain text, markdown-bold with **, bullets starting with "* "):\n` +
    `**Study Summary**\n` +
    `<one flowing paragraph of 2-4 sentences explaining what this page teaches>\n\n` +
    `**Key points**\n` +
    `* <key point>\n` +
    `* <key point>\n` +
    `* <key point>\n\n` +
    `Rules:\n` +
    `- Base EVERY sentence on the page text below — quote its exact terms, names and figures. Do NOT invent facts.\n` +
    `- Keep it under 220 words.\n` +
    `- No markdown code fences, no headings other than the two shown.\n` +
    `- If the page has no readable text (blank or a scanned image), reply with exactly: NO_TEXT\n\n` +
    `PAGE TEXT:\n${pageText}`
  );
}

/* Parse the cached content JSON — a corrupt row must never break the run. */
function parseCached(content: string): CachedPage[] {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((p) => {
        const o = (p ?? {}) as Record<string, unknown>;
        const page = typeof o.page === 'number' ? o.page : NaN;
        const text = typeof o.text === 'string' ? o.text : '';
        return { page, text };
      })
      .filter((p) => Number.isFinite(p.page) && p.page >= 1);
  } catch {
    return [];
  }
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();

  if (!EMAIL_RE.test(email) || !id) {
    return Response.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  const pdf = await db.pdf
    .findFirst({
      where: { id, userEmail: email },
      select: { id: true, name: true, storedAs: true, blobUrl: true },
    })
    .catch(() => null);
  if (!pdf) {
    return Response.json({ ok: false, error: 'notFound' }, { status: 404 });
  }

  const cachedRow = await db.pdfSummary
    .findUnique({ where: { pdfId: pdf.id } })
    .catch(() => null);
  const cached = parseCached(cachedRow?.content ?? '[]');

  const encoder = new TextEncoder();
  let aborted = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        if (aborted) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* client gone */
        }
      };

      const onAbort = () => {
        aborted = true;
      };
      request.signal.addEventListener('abort', onAbort);

      try {
        /* ── The stored binary must exist and be a readable PDF ── */
        let buf: Buffer;
        try {
          buf = await loadPdfBytes(pdf);
        } catch (err) {
          console.warn(
            '[pdfs/summary] stored binary unreadable:',
            pdf.storedAs,
            (err as NodeJS.ErrnoException)?.code ?? err
          );
          send({ type: 'error', error: 'missing' });
          return;
        }

        let doc;
        try {
          doc = await getDocumentProxy(new Uint8Array(buf));
        } catch (err) {
          console.warn('[pdfs/summary] not a readable PDF:', pdf.storedAs, err);
          send({ type: 'error', error: 'corrupt' });
          return;
        }

        /* Real page count — straight from the document. */
        const total = Math.min(doc.numPages, MAX_PAGES);
        send({ type: 'meta', total });

        /* Replay whatever was already summarised (instant). */
        const pages: CachedPage[] = cached
          .filter((p) => p.page <= total)
          .sort((a, b) => a.page - b.page);
        for (const p of pages) {
          send({ type: 'page', page: p.page, total, text: p.text });
        }
        let pagesDone = pages.length;
        let rateLimitStrikes = 0;

        if (pagesDone < total && !aborted) {
          /* Per-page text extraction (mergePages: false → array per page). */
          const { text: pageTexts } = await extractText(doc, {
            mergePages: false,
          });
          const zai = await ZAI.create();

          for (let i = pagesDone; i < total; i++) {
            if (aborted) break;

            const raw = String(pageTexts[i] ?? '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, MAX_PAGE_CHARS);

            let out = NO_TEXT;
            if (raw) {
              /* The shared helper retries transient failures (429/5xx) with
                 exponential backoff; a page that still fails is marked and
                 the run continues — never kill a long summary. */
              try {
                const completion = await createChatCompletion(zai, {
                  messages: [
                    {
                      role: 'assistant',
                      content: buildPagePrompt(raw, pdf.name),
                    },
                    {
                      role: 'user',
                      content: `Summarize page ${i + 1} of my PDF "${pdf.name}" in the study-notes format.`,
                    },
                  ],
                  thinking: { type: 'disabled' },
                });
                const reply = (completion.choices[0]?.message?.content ?? '')
                  .replace(/```(?:markdown|md|text)?\s*|```/g, '')
                  .trim();
                if (reply && !/^no_text$/i.test(reply)) out = reply;
                rateLimitStrikes = 0;
              } catch (error) {
                if (error instanceof AiRateLimitError) {
                  rateLimitStrikes += 1;
                  console.warn(
                    `[pdfs/summary] page ${i + 1} rate-limited (strike ${rateLimitStrikes}/${MAX_RATE_LIMIT_STRIKES})`
                  );
                } else {
                  console.warn(
                    `[pdfs/summary] page ${i + 1} failed — continuing`,
                    error
                  );
                }
                out = PAGE_FAILED;
              }
            }

            pages.push({ page: i + 1, text: out });
            pagesDone = pages.length;
            send({ type: 'page', page: i + 1, total, text: out });

            /* Persist after every page → Stop keeps the progress.
               A persistence hiccup must not kill the stream. */
            await db.pdfSummary
              .upsert({
                where: { pdfId: pdf.id },
                update: {
                  pagesDone,
                  totalPages: total,
                  content: JSON.stringify(pages),
                },
                create: {
                  pdfId: pdf.id,
                  userEmail: email,
                  pagesDone,
                  totalPages: total,
                  content: JSON.stringify(pages),
                },
              })
              .catch((err) =>
                console.warn('[pdfs/summary] progress persist failed:', err)
              );

            /* Quota circuit breaker: the shared LLM limit is exhausted on
               several consecutive pages — stop instead of hammering the API
               so the user's other AI features (chat, quiz, …) keep working.
               Progress is persisted above, so Resume picks up from here. */
            if (rateLimitStrikes >= MAX_RATE_LIMIT_STRIKES) {
              console.warn(
                '[pdfs/summary] stopping: LLM rate limit exhausted on',
                rateLimitStrikes,
                'consecutive pages'
              );
              send({ type: 'error', error: 'rate_limited' });
              return;
            }

            /* Small pause between pages keeps burst rate low. */
            if (i + 1 < total && !aborted) {
              await sleep(INTER_PAGE_DELAY_MS);
            }
          }
        }

        if (!aborted) send({ type: 'end', done: pagesDone >= total });
      } catch (error) {
        console.error('[pdfs/summary] fatal:', error);
        try {
          send({ type: 'error', error: 'server' });
        } catch {
          /* client already gone */
        }
      } finally {
        request.signal.removeEventListener('abort', onAbort);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      aborted = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
