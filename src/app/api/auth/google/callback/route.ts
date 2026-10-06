import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { db } from '@/lib/db';
import {
  cleanGoogleRedirectUri,
  googleBridgeKey,
  googleCredentials,
} from '@/lib/google-credentials';

/**
 * GET /api/auth/google/callback?code=...&state=...
 *
 * Finishes the Google OAuth 2.0 authorization-code flow:
 *   1. Parses `state` ("<random>~<originB64>") — the origin where the
 *      flow STARTED (base64url). When the browser also carries the
 *      `g_oauth_state` cookie (same-origin flow) the random halves must
 *      match (CSRF). Cross-origin flows (sandbox preview / localhost
 *      bouncing through the registered GOOGLE_REDIRECT_URI) have no
 *      cookie on this host by design — the CSRF check then happens at
 *      the /bridge hop, which IS on the starting origin and can see the
 *      cookie.
 *   2. Exchanges the code for tokens at oauth2.googleapis.com/token
 *      (redirect_uri = GOOGLE_REDIRECT_URI env override, or rebuilt from
 *      the state's origin — mirroring /url exactly).
 *   3. Reads the profile via the userinfo endpoint (sub, email, name).
 *   4. Links or creates the local account (googleId/googleEmail — the
 *      same fields the Profile section reads) and marks the email
 *      verified (Google already verified it).
 *   5a. SAME-ORIGIN flow → responds with a tiny brand-styled bridge page
 *       that writes the client session (localStorage "gyanzo-session")
 *       and redirects to "/" — the reader lands on the Dashboard.
 *   5b. CROSS-ORIGIN flow (started on a different origin than this
 *       callback) → 302 to `<origin>/api/auth/google/bridge#p=<signed
 *       payload>`; the bridge on the starting origin verifies the
 *       HMAC-signed payload against its own state cookie, writes the
 *       session and lands on the Dashboard. This makes Google sign-in
 *       work from ANY origin (sandbox preview panel, localhost, preview
 *       deployments) with only ONE registered redirect_uri.
 *
 *   Brand-new accounts AND accounts that never finished the Profile-Setup
 *   onboarding (profileCompletedAt is null) also get the
 *   "gyanzo-profile-setup" flag, which makes the app open the Profile
 *   Completion pages right on top of the Dashboard. Only accounts that
 *   already completed the onboarding skip it (returning users → straight
 *   to the Dashboard).
 *
 * Any failure renders the same page in an error state with a way back.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** JSON made safe for inline <script> embedding. */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const PAGE_STYLE =
  'margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#edfdf4;font-family:Poppins,system-ui,-apple-system,sans-serif;color:#04102e';

const LOGO_SVG =
  '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>';

const LOGO_BOX = `width:56px;height:56px;margin:0 auto 1.25rem;border-radius:50%;background:#04b87a;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px rgba(4,184,122,.35)`;

/** Brand-styled error page with a way back. */
function fail(message: string): NextResponse {
  console.error('[auth/google/callback]', message);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign-in failed — Gyanzo</title></head>
<body style="${PAGE_STYLE}"><div style="text-align:center;padding:2rem">
<div style="${LOGO_BOX}">${LOGO_SVG}</div>
<p style="font-size:1.05rem;font-weight:600">${safeJson(message).slice(1, -1)}</p>
<a href="/" style="display:inline-block;margin-top:1.25rem;padding:.65rem 1.4rem;border-radius:.75rem;background:#029966;color:#fff;font-size:.875rem;font-weight:600;text-decoration:none">Back to Gyanzo</a>
</div></body></html>`;
  const res = new NextResponse(html, {
    status: 400,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
  // One-time state — always clear it.
  res.cookies.set('g_oauth_state', '', { path: '/', maxAge: 0 });
  return res;
}

/** Strict origin validator — used on the bounce target so a crafted
 *  state can never redirect anyone to a non-origin URL. */
function safeOrigin(raw: string): string {
  if (!raw || raw.length > 200) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    if (u.username || u.password) return '';
    if (u.pathname !== '/' || u.search || u.hash) return '';
    return u.origin;
  } catch {
    return '';
  }
}

/** This server's public origin, rebuilt behind proxies. */
function selfOrigin(request: NextRequest): string {
  const fwdHost = request.headers.get('x-forwarded-host');
  const host = (fwdHost ? fwdHost.split(',')[0] : null) ?? request.headers.get('host') ?? '';
  const proto = (request.headers.get('x-forwarded-proto') ?? '').split(',')[0] ||
    (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
  if (!host) return request.nextUrl.origin;
  return `${proto}://${host}`;
}

/** HMAC key for the cross-origin session handoff — shared with /bridge
 *  via google-credentials.ts so signer and verifier never drift apart. */
const bridgeKey = googleBridgeKey;

export async function GET(request: NextRequest) {
  /* ── 0. Parse state + cookie ────────────────────────────────── */
  const state = request.nextUrl.searchParams.get('state') ?? '';
  const [stateRandom, stateOriginB64] = state.split('~');
  let stateOrigin = '';
  try {
    stateOrigin = Buffer.from(stateOriginB64 ?? '', 'base64url').toString('utf8');
  } catch {
    stateOrigin = '';
  }
  stateOrigin = safeOrigin(stateOrigin);

  const cookie = request.cookies.get('g_oauth_state')?.value ?? '';
  const [cookieRandom] = cookie.split('~');

  const code = request.nextUrl.searchParams.get('code') ?? '';

  // CSRF: when the browser DID carry the state cookie (same-origin
  // flow), the random halves must match. No cookie at all = cross-origin
  // bounce flow — validated at the /bridge hop instead.
  if (cookieRandom && cookieRandom !== stateRandom) {
    return fail(
      'We could not verify this sign-in attempt. Please go back and try again.'
    );
  }
  if (!stateRandom || !stateOrigin) {
    return fail(
      'We could not verify this sign-in attempt. Please go back and try again.'
    );
  }
  if (!code) {
    return fail(
      'Google did not return an authorization code. Please try signing in again.'
    );
  }

  const creds = googleCredentials();
  if (!creds) {
    return fail('Google sign-in is not configured on this server.');
  }

  try {
    /* ── 1. Code → tokens ─────────────────────────────────────── */
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri:
          cleanGoogleRedirectUri(process.env.GOOGLE_REDIRECT_URI) ||
          `${stateOrigin}/api/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      return fail(
        'Google refused the token exchange. Please try signing in again.'
      );
    }
    const tokens = (await tokenRes.json()) as { access_token?: string };
    if (!tokens.access_token) {
      return fail(
        'Google did not return an access token. Please try signing in again.'
      );
    }

    /* ── 2. Access token → profile ────────────────────────────── */
    const infoRes = await fetch(
      'https://www.googleapis.com/oauth2/v3/userinfo',
      { headers: { Authorization: `Bearer ${tokens.access_token}` } }
    );
    if (!infoRes.ok) {
      return fail('Could not read your Google profile. Please try again.');
    }
    const info = (await infoRes.json()) as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
    };
    const email = (info.email ?? '').trim().toLowerCase();
    if (!info.sub || !EMAIL_RE.test(email)) {
      return fail(
        'Your Google account did not share an email address with Gyanzo.'
      );
    }

    /* ── 3. Link or create the local account ──────────────────── */
    const now = new Date();
    const name = (info.name ?? '').trim() || email.split('@')[0];
    const existing = await db.user.findUnique({ where: { email } });
    const user = existing
      ? await db.user.update({
          where: { email },
          data: {
            googleId: info.sub,
            googleEmail: email,
            ...(existing.emailVerified ? {} : { emailVerified: now }),
          },
        })
      : await db.user.create({
          data: {
            email,
            name,
            googleId: info.sub,
            googleEmail: email,
            emailVerified: now,
          },
        });

    /* ── 4. Bridge the client session → Dashboard ─────────────── */
    // Brand-new Google accounts AND accounts that never finished the
    // Profile-Setup onboarding go through Profile Completion first;
    // only fully-onboarded returning users land straight on the Dashboard.
    const needsProfileSetup = !existing || !existing.profileCompletedAt;
    const session = {
      name: user.name ?? email.split('@')[0],
      email: user.email,
    };

    const origin = selfOrigin(request);
    const key = bridgeKey();

    /* ── 5b. Cross-origin flow → signed bounce to the origin ──── */
    if (key && stateOrigin && stateOrigin !== origin) {
      const payload = Buffer.from(
        JSON.stringify({
          n: session.name,
          e: session.email,
          p: needsProfileSetup ? 1 : 0,
          s: stateRandom,
          exp: Date.now() + 120_000,
        })
      ).toString('base64url');
      const sig = createHmac('sha256', key).update(payload).digest('base64url');
      const res = NextResponse.redirect(
        `${stateOrigin}/api/auth/google/bridge#p=${payload}.${sig}`,
        302
      );
      res.cookies.set('g_oauth_state', '', { path: '/', maxAge: 0 });
      res.headers.set('Cache-Control', 'no-store');
      console.log(
        `[auth/google/callback] cross-origin bounce → ${stateOrigin} (user=${email})`
      );
      return res;
    }

    /* ── 5a. Same-origin flow → inline bridge page ────────────── */
    // Pending → show the onboarding; already completed → make sure no
    // stale flag from an earlier visit can pop it up again.
    const flagJs = needsProfileSetup
      ? "localStorage.setItem('gyanzo-profile-setup','1');"
      : "localStorage.removeItem('gyanzo-profile-setup');";
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signing you in — Gyanzo</title></head>
<body style="${PAGE_STYLE}"><div style="text-align:center">
<div style="${LOGO_BOX}">${LOGO_SVG}</div>
<p style="font-size:1.05rem;font-weight:600">Signing you in&#8230;</p>
</div>
<script>
try{localStorage.setItem('gyanzo-session',JSON.stringify(${safeJson(session)}));${flagJs}}catch(e){}
setTimeout(function(){location.replace('/');},250);
</script></body></html>`;
    const res = new NextResponse(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
    res.cookies.set('g_oauth_state', '', { path: '/', maxAge: 0 });
    return res;
  } catch (error) {
    console.error('[auth/google/callback] unexpected error:', error);
    return fail('Unexpected server error. Please try signing in again.');
  }
}
