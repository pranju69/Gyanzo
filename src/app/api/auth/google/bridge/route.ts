import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * GET  /api/auth/google/bridge#p=<payload>.<sig>
 * POST /api/auth/google/bridge        Body: { p: "<payload>.<sig>" }
 *
 * Landing pad for the CROSS-ORIGIN Google OAuth bounce. When sign-in
 * starts on an origin that is not the registered redirect_uri (sandbox
 * preview panel, localhost, a preview deployment), the Google callback
 * runs on the registered host and cannot write this origin's localStorage.
 * Instead it 302s here with an HMAC-signed session payload in the URL
 * fragment (fragments never reach any server or access log).
 *
 * GET  → brand-styled shell page; its inline script reads the fragment
 *        and POSTs it right back to this route for verification.
 * POST → verifies HMAC(GOOGLE_BRIDGE_SECRET || GOOGLE_CLIENT_SECRET),
 *        the 120 s expiry, and — CSRF — that the payload's `s` random
 *        matches THIS origin's `g_oauth_state` cookie (set by /url when
 *        the flow started here; this hop is same-origin so the cookie
 *        IS available). Responds { ok, session, needsProfileSetup }.
 *
 * The page then writes localStorage "gyanzo-session" (+"gyanzo-profile-
 * setup" for accounts still to onboard), scrubs the fragment and lands
 * on "/" — the Dashboard. Any failure shows the brand error state.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PAGE_STYLE =
  'margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#edfdf4;font-family:Poppins,system-ui,-apple-system,sans-serif;color:#04102e';

const LOGO_SVG =
  '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>';

const LOGO_BOX = `width:56px;height:56px;margin:0 auto 1.25rem;border-radius:50%;background:#04b87a;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px rgba(4,184,122,.35)`;

function noStore(res: NextResponse): NextResponse {
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

export async function GET() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signing you in — Gyanzo</title></head>
<body style="${PAGE_STYLE}"><div style="text-align:center">
<div style="${LOGO_BOX}">${LOGO_SVG}</div>
<p id="msg" style="font-size:1.05rem;font-weight:600">Signing you in&#8230;</p>
<a id="back" href="/" style="display:none;margin-top:1.25rem;padding:.65rem 1.4rem;border-radius:.75rem;background:#029966;color:#fff;font-size:.875rem;font-weight:600;text-decoration:none">Back to Gyanzo</a>
</div>
<script>
(function(){
  var msg=document.getElementById('msg');
  var back=document.getElementById('back');
  function fail(text){
    if(msg) msg.textContent=text||'Sign-in could not be completed. Please try again.';
    if(back) back.style.display='inline-block';
  }
  var m=location.hash.match(/p=([A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)/);
  if(!m){ fail(); return; }
  try{ history.replaceState(null,'',location.pathname); }catch(e){}
  var ctrl=('AbortController' in window)? new AbortController() : null;
  var timer=ctrl? setTimeout(function(){ctrl.abort();},10000) : null;
  fetch('/api/auth/google/bridge',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({p:m[1]}),
    signal:ctrl?ctrl.signal:undefined,
    credentials:'same-origin'
  }).then(function(r){ return r.json(); }).then(function(d){
    if(timer) clearTimeout(timer);
    if(d&&d.ok){
      try{
        localStorage.setItem('gyanzo-session',JSON.stringify(d.session));
        if(d.needsProfileSetup){localStorage.setItem('gyanzo-profile-setup','1');}
        else{localStorage.removeItem('gyanzo-profile-setup');}
      }catch(e){}
      location.replace('/');
    } else { fail(); }
  }).catch(function(){ if(timer) clearTimeout(timer); fail(); });
})();
</script></body></html>`;
  return noStore(
    new NextResponse(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  );
}

interface BridgePayload {
  n?: string;
  e?: string;
  p?: number;
  s?: string;
  exp?: number;
}

export async function POST(request: NextRequest) {
  const key =
    process.env.GOOGLE_BRIDGE_SECRET?.trim() ||
    process.env.GOOGLE_CLIENT_SECRET?.trim() ||
    '';
  if (!key) {
    return NextResponse.json({ ok: false, error: 'notConfigured' }, { status: 500 });
  }

  let token = '';
  try {
    const body = (await request.json()) as { p?: string };
    token = String(body?.p ?? '');
  } catch {
    token = '';
  }
  const dot = token.indexOf('.');
  const payloadB64 = dot > 0 ? token.slice(0, dot) : '';
  const sigB64 = dot > 0 ? token.slice(dot + 1) : '';
  if (!payloadB64 || !sigB64 || sigB64.length > 128 || payloadB64.length > 4096) {
    return NextResponse.json({ ok: false, error: 'malformed' }, { status: 400 });
  }

  // Signature (timing-safe).
  const expected = createHmac('sha256', key).update(payloadB64).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sigB64, 'base64url');
  } catch {
    return NextResponse.json({ ok: false, error: 'malformed' }, { status: 400 });
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return NextResponse.json({ ok: false, error: 'badSignature' }, { status: 400 });
  }

  // Payload shape + expiry.
  let payload: BridgePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return NextResponse.json({ ok: false, error: 'malformed' }, { status: 400 });
  }
  const email = String(payload.e ?? '').trim().toLowerCase();
  const name = String(payload.n ?? '').trim();
  if (!payload.exp || typeof payload.exp !== 'number' || payload.exp < Date.now()) {
    return NextResponse.json({ ok: false, error: 'expired' }, { status: 400 });
  }
  if (!name || !EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: 'malformed' }, { status: 400 });
  }

  // CSRF: the flow must have started HERE — this origin's state cookie
  // carries the same random the callback signed into the payload.
  const cookie = request.cookies.get('g_oauth_state')?.value ?? '';
  const [cookieRandom] = cookie.split('~');
  if (!cookieRandom || !payload.s || cookieRandom !== payload.s) {
    return NextResponse.json({ ok: false, error: 'stateMismatch' }, { status: 400 });
  }

  return noStore(
    NextResponse.json({
      ok: true,
      needsProfileSetup: payload.p === 1,
      session: { name, email },
    })
  );
}
