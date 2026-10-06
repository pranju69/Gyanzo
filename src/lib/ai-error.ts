/**
 * Client-side helper: pick the right toast title for a failed AI request.
 *
 * The AI routes return structured error codes:
 *   · 'ai_not_configured' (503) — no provider on this host (see
 *     src/lib/ai-client.ts) → show the actionable aiNotConfigured message
 *     instead of a generic "Something went wrong".
 *   · 'rate_limited' (429) — shared LLM quota exhausted → "AI is busy".
 *   · anything else → the view's regular failure message.
 */
export function aiErrorTitle(
  data: { error?: string } | null | undefined,
  fallback: string,
  notConfigured: string,
  rateLimited?: string
): string {
  if (data?.error === 'ai_not_configured') return notConfigured;
  if (data?.error === 'rate_limited' && rateLimited) return rateLimited;
  return fallback;
}
