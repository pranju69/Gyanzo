import 'server-only';
import type {
  AiClient,
  AiCompletionParams,
  AiCompletionResult,
} from '@/lib/ai-client';

/**
 * Shared resilient LLM completion helper.
 *
 * Every AI feature in the app (chat, quiz, flashcards, summaries, …) shares
 * one per-account rate limit on the LLM API. When a feature is refused with
 * HTTP 429 "Too many requests" the SDK throws a plain Error immediately —
 * routes that call the API only once turn that into a user-facing failure
 * ("Something went wrong") even though the limit clears within seconds.
 *
 * `createChatCompletion` wraps `zai.chat.completions.create` with:
 *   · exponential backoff + jitter on transient errors (429 / 5xx / network)
 *   · an overall deadline so callers stay inside their Vercel maxDuration
 *   · `AiRateLimitError` when the quota is still exhausted at the deadline,
 *     letting callers return a distinct, localisable "AI is busy" error
 *     instead of a generic 500.
 */

export class AiRateLimitError extends Error {
  constructor(message = 'LLM rate limit exhausted') {
    super(message);
    this.name = 'AiRateLimitError';
  }
}

export type ChatCompletionParams = AiCompletionParams;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Detect the SDK's 429/limit errors from the thrown message. */
function isRateLimitError(error: unknown): boolean {
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return /status 429|too many requests|rate.?limit/i.test(msg);
}

/** Network/server hiccups worth retrying (not client mistakes like 400). */
function isTransientError(error: unknown): boolean {
  if (isRateLimitError(error)) return true;
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return (
    /status 5\d\d|failed to make api request|fetch failed|network|timeout|socket/i.test(
      msg
    ) || error instanceof TypeError
  );
}

/**
 * Retry-aware chat completion.
 *
 * @param deadlineMs total retry budget (default 25 s — chat/quiz routes run
 *        with maxDuration 60, so there is headroom for persistence + IO).
 */
export async function createChatCompletion(
  zai: AiClient,
  params: ChatCompletionParams,
  opts?: { deadlineMs?: number }
): Promise<AiCompletionResult> {
  const deadlineMs = opts?.deadlineMs ?? 25_000;
  const start = Date.now();

  /* Backoff schedule (capped by the remaining deadline). */
  const delays = [800, 2_000, 4_000, 7_000, 10_000];

  let lastError: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      return await zai.chat.completions.create(params);
    } catch (error) {
      lastError = error;
      const transient = isTransientError(error);
      const delay = delays[Math.min(attempt, delays.length - 1)] ?? 10_000;
      const elapsed = Date.now() - start;
      if (!transient || elapsed + delay > deadlineMs) break;

      /* +0-40 % jitter so concurrent callers don't sync into a stampede. */
      const jittered = Math.round(delay * (1 + Math.random() * 0.4));
      console.warn(
        `[ai] transient LLM error (attempt ${attempt + 1}), retrying in ${jittered}ms:`,
        error instanceof Error ? error.message : error
      );
      await sleep(jittered);
    }
  }

  if (isRateLimitError(lastError)) throw new AiRateLimitError();
  throw lastError;
}
