/**
 * Google OAuth credential recovery.
 *
 * Production incident (gyanzo-six.vercel.app): the Vercel environment had
 * GOOGLE_CLIENT_ID pasted as a multi-line blob that also contained the
 * secret — e.g.
 *
 *   19065256979-xxxx.apps.googleusercontent.com
 *   GOOGLE_CLIENT_SECRET=GOCSPX-yyyy
 *
 * The raw value was sent to Google as `client_id=<blob>` → instant
 * "invalid_request" on the consent screen, so sign-in failed for everyone
 * while every local environment stayed healthy.
 *
 * Instead of trusting the environment to be tidy, these helpers treat the
 * raw env values as a POOL of text and recover the canonical credentials
 * from it, no matter how they were pasted:
 *   - client id   → matches the canonical `…-….apps.googleusercontent.com`
 *                   shape anywhere in the pool.
 *   - client secret → `GOOGLE_CLIENT_SECRET=…` assignment line, or a
 *                   `GOCSPX-…` token, or a clean single-line value.
 * A value is only accepted once it matches Google's known shape, so stray
 * quotes, whitespace, env-style prefixes and trailing newlines all get
 * healed automatically.
 */

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
}

/** Canonical Google OAuth client id, e.g. 19065256979-abc123….apps… */
const CLIENT_ID_RE = /\d{6,}-[A-Za-z0-9_.-]+\.apps\.googleusercontent\.com/;

/** `GOOGLE_CLIENT_SECRET=xxxx` assignment inside a pasted blob. */
const SECRET_ASSIGN_RE =
  /GOOGLE_CLIENT_SECRET\s*[:=]\s*["']?([A-Za-z0-9_./+=-]{16,})["']?/;

/** Modern Google client secrets all start with GOCSPX-. */
const SECRET_TOKEN_RE = /GOCSPX-[A-Za-z0-9_-]{10,}/;

/** Everything the env could possibly hold, flattened into one pool. */
function pool(...raws: Array<string | undefined>): string {
  return raws.filter((v): v is string => typeof v === 'string').join('\n');
}

/** First line of a value — heals "https://host/path\nGARBAGE" pastes. */
function firstLine(raw: string): string {
  const line = raw.split('\n').map((l) => l.trim()).find(Boolean);
  return (line ?? raw.trim()).replace(/^["']|["']$/g, '');
}

/** Recover the client id from one raw env value (falls back to trim). */
export function cleanGoogleClientId(raw: string | undefined): string {
  const poolText = pool(raw);
  const hit = poolText.match(CLIENT_ID_RE);
  if (hit) return hit[0];
  const line = firstLine(raw ?? '');
  return line.endsWith('.apps.googleusercontent.com') ? line : '';
}

/** Recover the client secret from one raw env value. */
export function cleanGoogleClientSecret(raw: string | undefined): string {
  const poolText = pool(raw);
  const assigned = poolText.match(SECRET_ASSIGN_RE);
  if (assigned) return assigned[1];
  const token = poolText.match(SECRET_TOKEN_RE);
  if (token) return token[0];
  const line = firstLine(raw ?? '');
  // Last resort: an unannotated single-line value that is clearly not a
  // client id and carries no whitespace/quotes from a bad paste.
  if (
    line.length >= 16 &&
    !/\s/.test(line) &&
    !line.includes('apps.googleusercontent.com') &&
    !line.includes('GOOGLE_CLIENT_ID=')
  ) {
    return line;
  }
  return '';
}

/** Redirect URI override, healed to a single clean line (may be ''). */
export function cleanGoogleRedirectUri(raw: string | undefined): string {
  return raw?.trim() ? firstLine(raw) : '';
}

/** Both credentials at once, or null when the server has none. */
export function googleCredentials(): GoogleCredentials | null {
  const clientId = cleanGoogleClientId(process.env.GOOGLE_CLIENT_ID);
  const clientSecret = cleanGoogleClientSecret(
    pool(
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_CLIENT_ID
    )
  );
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * HMAC key for the cross-origin /bridge session handoff. Kept HERE so
 * /callback (signer) and /bridge (verifier) can never drift apart — they
 * must derive the exact same key or every bounce flow fails CSRF.
 */
export function googleBridgeKey(): string {
  const override = process.env.GOOGLE_BRIDGE_SECRET?.trim();
  if (override) return override;
  return googleCredentials()?.clientSecret ?? '';
}
