'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, type Variants } from 'framer-motion';
import { Eye, EyeOff, GraduationCap, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import VerifyEmailView from '@/components/auth/verify-email';
import LanguageSwitcher from '@/components/language-switcher';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/lib/i18n';
import {
  setSession,
  markProfileSetupPending,
  clearProfileSetup,
  getSessionSnapshot,
  subscribeSession,
} from '@/lib/session';

export type AuthMode = 'signin' | 'signup';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when the app runs inside an iframe (the sandbox preview panel
 *  does). Google's consent page sends X-Frame-Options: DENY, so inside
 *  a frame the OAuth flow MUST be launched in a real browser tab. */
const RUNS_IN_IFRAME = (() => {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
    return true; // cross-origin frame access threw → we are framed
  }
})();

const cardVariants: Variants = {
  enter: (dir: number) => ({ opacity: 0, x: dir * 56 }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: dir * -56 }),
};

type Errors = Partial<
  Record<'fullName' | 'email' | 'password' | 'confirm' | 'agree', string>
>;

/**
 * Full-screen Sign In / Sign Up pages (light, airy background + dark navy
 * card) matching the Gyanzo auth design. Opened from the landing "Get
 * started" CTA; the two pages cross-slide into each other.
 * Fully localized via useLanguage(); the glass pill (top-right) switches
 * the language for the whole app.
 */
export default function AuthFlow({
  initialMode = 'signin',
  onClose,
  onVerified,
}: {
  initialMode?: AuthMode;
  onClose: () => void;
  /** Called after a new account verifies its email — hands over the
   *  sign-up identity so the profile-setup onboarding can start. */
  onVerified?: (user: { name: string; email: string }) => void;
}) {
  const { toast } = useToast();
  const { t } = useLanguage();
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [dir, setDir] = useState<1 | -1>(1);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [remember, setRemember] = useState(true);
  const [agree, setAgree] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState<'email' | 'google' | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  /** Email awaiting verification — when set, the Verify Your Email page replaces the auth cards. */
  const [verifyEmail, setVerifyEmail] = useState<string | null>(null);
  /* How the FIRST code for the current verify screen was delivered — the
     verify card shows a persistent banner from it (demo code or inbox note). */
  const [verifyDelivery, setVerifyDelivery] = useState<{
    delivered: boolean;
    demoCode: string | null;
  }>({ delivered: false, demoCode: null });
  /** Sign-up password kept (in memory only) until the code is verified,
   *  then stored hashed via /api/auth/register. */
  const passwordRef = useRef('');

  /** Demo Google chooser — the honest fallback when this server has no
   *  Google OAuth credentials (same idea as the visible demo code for
   *  email verification). */
  const [googleOpen, setGoogleOpen] = useState(false);
  const [googleEmail, setGoogleEmail] = useState('');
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);
  /** Consent URL for the iframe + popup-blocked fallback: a manual
   *  <a target="_blank"> the user can click (user gesture → allowed). */
  const [consentUrl, setConsentUrl] = useState<string | null>(null);
  /** Aborts the in-iframe Google relay listener on unmount/retry. */
  const googleRelayRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape peels one layer at a time: demo chooser → the whole auth flow.
      if (googleOpen) {
        setGoogleOpen(false);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKey);
      googleRelayRef.current?.abort();
      googleRelayRef.current = null;
    };
  }, [onClose, googleOpen]);

  /* Google-in-iframe flow: the consent tab bounces back to this origin's
   * /bridge, which writes the session into the shared localStorage. The
   * instant it appears, drop the spinner — the app shell listens to the
   * same store and swaps this iframe to the Dashboard, unmounting the
   * whole auth dialog. */
  useEffect(() => {
    if (loading !== 'google') return;
    if (getSessionSnapshot()) {
      setLoading(null);
      return;
    }
    return subscribeSession(() => {
      if (getSessionSnapshot()) setLoading(null);
    });
  }, [loading]);

  const clearError = (field: keyof Errors) =>
    setErrors((prev) => {
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });

  const switchMode = (next: AuthMode) => {
    setDir(next === 'signup' ? 1 : -1);
    setShowPassword(false);
    setErrors({});
    setMode(next);
  };

  /** Google button: opens the real OAuth consent page when the server
   *  has credentials (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET); otherwise
   *  falls back to the clearly-labeled local demo sign-in. */
  const handleGoogle = async () => {
    if (loading !== null || googleBusy) return;
    setLoading('google');
    setGoogleError(null);
    try {
      const res = await fetch(
        `/api/auth/google/url?origin=${encodeURIComponent(window.location.origin)}`
      );
      const data = (await res.json().catch(() => null)) as {
        configured?: boolean;
        url?: string | null;
      } | null;
      if (data?.configured && data.url) {
        /* Google's consent page sends X-Frame-Options: DENY, so it can
         * NEVER render inside an iframe — navigating this window there
         * shows the browser's "refused to connect" screen instead (the
         * preview panel runs the app in one). Inside a frame we open
         * the consent page in a REAL tab: after consent the OAuth
         * callback bounces back to this origin's /bridge, which writes
         * the session into the shared localStorage. The session-watch
         * effect below (and the storage event the shell listens to)
         * then flips the app to the Dashboard automatically. */
        if (RUNS_IN_IFRAME) {
          /* Cookies set inside a third-party iframe are PARTITIONED away
           * from the popup tab — so the bounce cannot rely on the state
           * cookie. Instead, remember the exact state random this dialog
           * issued (in memory) and verify the relayed payload against it. */
          let expectedRandom = '';
          try {
            expectedRandom =
              (new URL(data.url).searchParams.get('state') ?? '').split('~')[0] ??
              '';
          } catch {
            /* consent URL always parses — defensive only */
          }
          /* NOTE: deliberately NOT 'noopener' — the bridge bounce page
           * must be able to postMessage this frame (window.opener).
           * The opened page is Google, then our own /bridge — trusted. */
          const popup = window.open(data.url, '_blank');
          if (popup) {
            if (!expectedRandom) return; // storage-event watch still active
            const controller = new AbortController();
            googleRelayRef.current?.abort();
            googleRelayRef.current = controller;
            window.addEventListener(
              'message',
              (ev: MessageEvent) => {
                if (ev.origin !== window.location.origin) return;
                const d = ev.data as { type?: string; p?: string } | null;
                if (!d || d.type !== 'gyanzo-oauth-relay' || typeof d.p !== 'string' || !d.p)
                  return;
                const dot = d.p.indexOf('.');
                if (dot <= 0) return;
                let payload: {
                  n?: string;
                  e?: string;
                  p?: number;
                  s?: string;
                  exp?: number;
                };
                try {
                  const b64 = d.p
                    .slice(0, dot)
                    .replace(/-/g, '+')
                    .replace(/_/g, '/');
                  payload = JSON.parse(
                    new TextDecoder().decode(
                      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
                    )
                  );
                } catch {
                  return;
                }
                /* CSRF: this popup may only complete the flow IT started —
                 * the signed payload must carry the exact state random this
                 * dialog received from /url, and must not be expired. (The
                 * payload's HMAC signature + expiry are already enforced by
                 * the bridge page before the relay.) */
                if (!payload || payload.s !== expectedRandom) return;
                if (typeof payload.exp !== 'number' || payload.exp < Date.now())
                  return;
                const email = String(payload.e ?? '').trim().toLowerCase();
                const name = String(payload.n ?? '').trim();
                if (!name || !EMAIL_RE.test(email)) return;
                setSession({ name, email });
                if (payload.p === 1) markProfileSetupPending();
                else clearProfileSetup();
                try {
                  (ev.source as Window | null)?.postMessage(
                    { type: 'gyanzo-oauth-relay-done' },
                    ev.origin
                  );
                } catch {
                  /* popup may already be closing */
                }
                controller.abort();
                googleRelayRef.current = null;
                setLoading(null);
              },
              { signal: controller.signal }
            );
            return; // spinner stays; relay/storage-watch completes the flow
          }
          // Popup blocked → keep the URL for a manual, user-gesture link.
          setConsentUrl(data.url);
          setLoading(null);
          return;
        }
        // Consent page takes over — keep the spinner while navigating.
        window.location.assign(data.url);
        return;
      }
      // No credentials on this server → honest local demo sign-in.
      setLoading(null);
      setGoogleOpen(true);
    } catch {
      toast({
        title: t.auth.googleErrorTitle,
        description: t.auth.googleErrorDesc,
      });
      setLoading(null);
    }
  };

  /** Demo sign-in: links/creates the Google-provider account through
   *  /api/auth/google/demo and completes the session like the email
   *  flow does (host handler → Dashboard / onboarding). */
  const handleGoogleDemo = async () => {
    if (googleBusy) return;
    const address = googleEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(address)) {
      setGoogleError(t.auth.errEmailInvalid);
      return;
    }
    setGoogleBusy(true);
    setGoogleError(null);
    try {
      const res = await fetch('/api/auth/google/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: address }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        created?: boolean;
        needsProfileSetup?: boolean;
        user?: { name: string; email: string };
      } | null;
      if (!data?.ok || !data.user) throw new Error('demo sign-in failed');
      toast({
        title: t.auth.googleToastTitle,
        description: t.auth.googleToastDesc,
      });
      // Brand-new demo accounts AND accounts that never finished the
      // profile-completion onboarding get Profile Setup — exactly like
      // the real OAuth callback decides it.
      if (data.created || data.needsProfileSetup) markProfileSetupPending();
      if (onVerified) {
        onVerified({ name: data.user.name, email: data.user.email });
      } else {
        setSession({ name: data.user.name, email: data.user.email });
        onClose();
      }
    } catch {
      toast({
        title: t.auth.googleErrorTitle,
        description: t.auth.googleErrorDesc,
      });
      setGoogleBusy(false);
    }
  };

  const handleForgotPassword = () => {
    toast({
      title: t.auth.resetToastTitle,
      description: t.auth.resetToastDesc(email.trim()),
    });
  };

  /** Code verified → persist the account (name + password hash) →
   *  hand over to the host (Dashboard) or close. */
  const handleVerified = async () => {
    const verifiedAddress = (verifyEmail ?? email).trim();
    try {
      await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: verifiedAddress,
          name: fullName.trim(),
          password: passwordRef.current,
        }),
      });
    } catch {
      // The code itself was verified — continue even if persistence hiccuped.
    }
    passwordRef.current = '';
    // Brand-new email account → run the Profile-Setup onboarding right
    // after the handover (same as brand-new Google accounts).
    markProfileSetupPending();
    toast({
      title: t.auth.verifiedToastTitle,
      description: t.auth.verifiedToastDesc,
    });
    if (onVerified) {
      onVerified({
        name: fullName.trim(),
        email: verifiedAddress,
      });
    } else {
      onClose();
    }
  };

  /** "Sign in with a different account" → back to the Sign In card. */
  const handleDifferentAccount = () => {
    setVerifyEmail(null);
    switchMode('signin');
  };

  const validate = (v: {
    fullName: string;
    email: string;
    password: string;
    confirm: string;
    agree: boolean;
  }): Errors => {
    const nextErrors: Errors = {};

    if (mode === 'signup' && v.fullName.trim().length < 2) {
      nextErrors.fullName = t.auth.errFullName;
    }

    if (!v.email.trim()) {
      nextErrors.email = t.auth.errEmailRequired;
    } else if (!EMAIL_RE.test(v.email.trim())) {
      nextErrors.email = t.auth.errEmailInvalid;
    }

    if (!v.password) {
      nextErrors.password = t.auth.errPasswordRequired;
    } else if (mode === 'signup' && v.password.length < 8) {
      nextErrors.password = t.auth.errPasswordSignup;
    } else if (mode === 'signin' && v.password.length < 6) {
      nextErrors.password = t.auth.errPasswordSignin;
    }

    if (mode === 'signup') {
      if (!v.confirm) {
        nextErrors.confirm = t.auth.errConfirmRequired;
      } else if (v.confirm !== v.password) {
        nextErrors.confirm = t.auth.errConfirmMismatch;
      }
      if (!v.agree) {
        nextErrors.agree = t.auth.errAgree;
      }
    }

    return nextErrors;
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading !== null) return;
    const nextErrors = validate({
      fullName,
      email,
      password,
      confirm,
      agree,
    });
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    // Sign In → real credential check against the Users table, then the
    // host takes over (Dashboard).
    if (mode === 'signin') {
      setLoading('email');
      try {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const res = await fetch('/api/auth/signin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), password }),
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.ok && data.user) {
          setPassword('');
          // Account exists but never finished the Profile-Setup onboarding
          // → run it now (same rule as the Google OAuth callback).
          if (data.profileComplete === false) markProfileSetupPending();
          toast({
            title: t.auth.signinToastTitle,
            description: t.auth.signinToastDesc(data.user.email),
          });
          if (onVerified) {
            onVerified({ name: data.user.name, email: data.user.email });
          } else {
            onClose();
          }
        } else if (data?.error === 'notFound') {
          toast({ title: t.auth.errNoAccount, variant: 'destructive' });
        } else if (data?.error === 'wrongPassword') {
          toast({ title: t.auth.errWrongPassword, variant: 'destructive' });
        } else {
          toast({ title: t.auth.verifyErrNetwork, variant: 'destructive' });
        }
      } catch {
        toast({ title: t.auth.verifyErrNetwork, variant: 'destructive' });
      } finally {
        setLoading(null);
      }
      return;
    }

    // Sign Up → generate + "send" a one-time verification code, then show
    // the Verify Your Email page for the address just registered.
    setLoading('email');
    try {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const res = await fetch('/api/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok && (data.delivered || data.demoCode)) {
        toast(
          data.delivered
            ? {
                title: t.auth.codeEmailedToastTitle,
                description: t.auth.codeEmailedToastDesc(email.trim()),
                duration: 15000,
              }
            : {
                title: t.auth.codeSentToastTitle,
                description: t.auth.codeSentToastDesc(
                  email.trim(),
                  data.demoCode
                ),
                duration: 15000,
              }
        );
        passwordRef.current = password;
        setPassword('');
        setConfirm('');
        setVerifyDelivery({
          delivered: Boolean(data.delivered),
          demoCode: data.delivered ? null : String(data.demoCode),
        });
        setVerifyEmail(email.trim());
      } else {
        toast({ title: t.auth.verifyErrNetwork, variant: 'destructive' });
      }
    } catch {
      toast({ title: t.auth.verifyErrNetwork, variant: 'destructive' });
    } finally {
      setLoading(null);
    }
  };

  const inputClass = (hasError: boolean) =>
    `h-11 rounded-xl border bg-white text-[15px] text-slate-900 placeholder:text-slate-400 focus-visible:border-emerald-500 focus-visible:ring-emerald-500/20 ${
      hasError
        ? 'border-red-400 focus-visible:border-red-500 focus-visible:ring-red-500/20'
        : 'border-slate-300'
    }`;

  const copy =
    mode === 'signin'
      ? {
          subtitle: t.auth.signinSubtitle,
          title: t.auth.signinTitle,
          tagline: t.auth.signinTagline,
          google: t.auth.signinGoogle,
          divider: t.auth.signinDivider,
          submit: t.auth.signinSubmit,
          switchPrompt: t.auth.switchToSignupPrompt,
          switchLabel: t.auth.signUpLink,
        }
      : {
          subtitle: t.auth.signupSubtitle,
          title: t.auth.signupTitle,
          tagline: t.auth.signupTagline,
          google: t.auth.signupGoogle,
          divider: t.auth.signupDivider,
          submit: t.auth.signupSubmit,
          switchPrompt: t.auth.switchToSigninPrompt,
          switchLabel: t.auth.signInLink,
        };

  return (
    <div
      className="fixed inset-0 z-[70] overflow-y-auto overscroll-contain"
      role="dialog"
      aria-modal="true"
      aria-label={
        verifyEmail
          ? t.auth.a11yVerifyDialog
          : mode === 'signin'
            ? t.auth.a11ySigninDialog
            : t.auth.a11ySignupDialog
      }
    >
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        className="relative min-h-dvh bg-white"
      >
        {/* ── Soft background wash (mint top, warm bottom) ──────── */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden"
        >
          <div className="absolute inset-x-0 top-0 h-[420px] bg-gradient-to-b from-emerald-50 via-emerald-50/40 to-transparent" />
          <div className="absolute -left-28 -top-28 h-80 w-80 rounded-full bg-emerald-200/45 blur-3xl" />
          <div className="absolute -right-32 -top-24 h-80 w-80 rounded-full bg-emerald-200/35 blur-3xl" />
          <div className="absolute left-1/2 top-[15%] h-56 w-[72%] -translate-x-1/2 rounded-full bg-emerald-100/60 blur-3xl" />
          <div className="absolute -bottom-48 left-1/2 h-[440px] w-[135%] -translate-x-1/2 rounded-full bg-[#e9e4b4]/60 blur-3xl" />
          <div className="absolute -bottom-24 left-1/4 h-64 w-[50%] rounded-full bg-[#efe9c0]/50 blur-3xl" />
        </div>

        {/* ── Language pill ──────────────────────────────────────── */}
        <div className="absolute right-4 top-4 z-10 sm:right-5 sm:top-5">
          <LanguageSwitcher variant="light" />
        </div>

        <div className="relative flex min-h-dvh flex-col px-4">
          <main className="flex flex-1 flex-col items-center justify-center py-8 sm:py-12">
            {/* ── Brand (click to go back to the landing page) ──── */}
            <button
              type="button"
              onClick={onClose}
              aria-label={t.auth.a11yBackHome}
              className="group flex flex-col items-center rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
            >
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-[0_12px_32px_rgba(16,185,129,0.35)] transition-transform duration-200 group-hover:scale-105">
                <GraduationCap
                  className="h-8 w-8 text-white"
                  strokeWidth={2.1}
                />
              </span>
              <span className="mt-4 text-2xl font-bold tracking-tight text-slate-900">
                Gyanzo
              </span>
            </button>

            {verifyEmail ? (
              <motion.div
                key="verify"
                initial={{ opacity: 0, x: 56 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.28, ease: 'easeOut' }}
                className="mt-4 flex w-full max-w-[430px] flex-col items-center"
              >
                <VerifyEmailView
                  email={verifyEmail}
                  initialDelivered={verifyDelivery.delivered}
                  initialDemoCode={verifyDelivery.demoCode}
                  onVerified={handleVerified}
                  onDifferentAccount={handleDifferentAccount}
                />
              </motion.div>
            ) : (
            <AnimatePresence mode="wait" custom={dir} initial={false}>
              <motion.div
                key={mode}
                custom={dir}
                variants={cardVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.28, ease: 'easeOut' }}
                className="mt-4 flex w-full max-w-[430px] flex-col items-center"
              >
                <p className="text-center text-[15px] text-slate-500">
                  {copy.subtitle}
                </p>

                {/* ── Card (light, matches the mint/cream page wash) ── */}
                <div className="mt-5 w-full rounded-2xl bg-white p-6 shadow-[0_24px_70px_-24px_rgba(2,12,27,0.25)] sm:p-8">
                  <h1 className="text-[28px] font-bold tracking-tight text-slate-900">
                    {copy.title}
                  </h1>
                  <p className="mt-1.5 text-sm text-slate-500">
                    {copy.tagline}
                  </p>

                  {/* Google */}
                  <button
                    type="button"
                    onClick={handleGoogle}
                    disabled={loading !== null}
                    className="mt-6 flex h-11 w-full items-center justify-center gap-2.5 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-60"
                  >
                    {loading === 'google' ? (
                      <Loader2
                        className="h-5 w-5 animate-spin text-slate-500"
                        aria-hidden="true"
                      />
                    ) : (
                      <GoogleIcon className="h-5 w-5" />
                    )}
                    {loading === 'google' ? (
                      t.auth.connecting
                    ) : (
                      copy.google
                    )}
                  </button>

                  {/* Iframe/preview-panel fallback: consent runs in a new
                      tab (Google refuses iframes). Shown when the popup
                      was blocked or needs a manual user-gesture click. */}
                  {consentUrl && (
                    <div
                      role="status"
                      className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-slate-700"
                    >
                      <p>{t.auth.googleNewTabDesc}</p>
                      <a
                        href={consentUrl}
                        target="_blank"
                        className="mt-2 inline-block rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-emerald-700"
                      >
                        {t.auth.googleNewTabOpen}
                      </a>
                    </div>
                  )}

                  {/* Divider */}
                  <div
                    className="my-5 flex items-center gap-3"
                    aria-hidden="true"
                  >
                    <span className="h-px flex-1 bg-slate-200" />
                    <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                      {copy.divider}
                    </span>
                    <span className="h-px flex-1 bg-slate-200" />
                  </div>

                  {/* Email form */}
                  <form
                    onSubmit={handleSubmit}
                    noValidate
                    className="space-y-4"
                  >
                    {mode === 'signup' && (
                      <div className="space-y-1.5">
                        <Label
                          htmlFor="fullName"
                          className="text-sm font-semibold text-slate-800"
                        >
                          {t.auth.labelFullName}
                        </Label>
                        <Input
                          id="fullName"
                          value={fullName}
                          onChange={(e) => {
                            setFullName(e.target.value);
                            clearError('fullName');
                          }}
                          placeholder={t.auth.phFullName}
                          autoComplete="name"
                          className={inputClass(Boolean(errors.fullName))}
                          aria-invalid={Boolean(errors.fullName)}
                        />
                        {errors.fullName && (
                          <p
                            role="alert"
                            className="text-xs font-medium text-red-500"
                          >
                            {errors.fullName}
                          </p>
                        )}
                      </div>
                    )}

                    <div className="space-y-1.5">
                      <Label
                        htmlFor="email"
                        className="text-sm font-semibold text-slate-800"
                      >
                        {t.auth.labelEmail}
                      </Label>
                      <Input
                        id="email"
                        type="email"
                        value={email}
                        onChange={(e) => {
                          setEmail(e.target.value);
                          clearError('email');
                        }}
                        placeholder={t.auth.phEmail}
                        autoComplete="email"
                        className={inputClass(Boolean(errors.email))}
                        aria-invalid={Boolean(errors.email)}
                      />
                      {errors.email && (
                        <p
                          role="alert"
                          className="text-xs font-medium text-red-500"
                        >
                          {errors.email}
                        </p>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <Label
                        htmlFor="password"
                        className="text-sm font-semibold text-slate-800"
                      >
                        {t.auth.labelPassword}
                      </Label>
                      <div className="relative">
                        <Input
                          id="password"
                          type={showPassword ? 'text' : 'password'}
                          value={password}
                          onChange={(e) => {
                            setPassword(e.target.value);
                            clearError('password');
                          }}
                          placeholder={
                            mode === 'signin'
                              ? t.auth.phPasswordSignin
                              : t.auth.phPasswordSignup
                          }
                          autoComplete={
                            mode === 'signin'
                              ? 'current-password'
                              : 'new-password'
                          }
                          className={`h-11 pr-11 ${inputClass(
                            Boolean(errors.password)
                          )}`}
                          aria-invalid={Boolean(errors.password)}
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((v) => !v)}
                          aria-label={
                            showPassword
                              ? t.auth.a11yHidePassword
                              : t.auth.a11yShowPassword
                          }
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition hover:text-slate-600"
                        >
                          {showPassword ? (
                            <EyeOff className="h-5 w-5" aria-hidden="true" />
                          ) : (
                            <Eye className="h-5 w-5" aria-hidden="true" />
                          )}
                        </button>
                      </div>
                      {errors.password && (
                        <p
                          role="alert"
                          className="text-xs font-medium text-red-500"
                        >
                          {errors.password}
                        </p>
                      )}
                    </div>

                    {mode === 'signup' && (
                      <div className="space-y-1.5">
                        <Label
                          htmlFor="confirm"
                          className="text-sm font-semibold text-slate-800"
                        >
                          {t.auth.labelConfirm}
                        </Label>
                        <Input
                          id="confirm"
                          type="password"
                          value={confirm}
                          onChange={(e) => {
                            setConfirm(e.target.value);
                            clearError('confirm');
                          }}
                          placeholder={t.auth.phConfirm}
                          autoComplete="new-password"
                          className={inputClass(Boolean(errors.confirm))}
                          aria-invalid={Boolean(errors.confirm)}
                        />
                        {errors.confirm && (
                          <p
                            role="alert"
                            className="text-xs font-medium text-red-500"
                          >
                            {errors.confirm}
                          </p>
                        )}
                      </div>
                    )}

                    {mode === 'signin' ? (
                      <div className="flex items-center justify-between pt-1">
                        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
                          <Checkbox
                            checked={remember}
                            onCheckedChange={(checked) =>
                              setRemember(checked === true)
                            }
                            className="border-slate-300 bg-white data-[state=checked]:border-slate-900 data-[state=checked]:bg-slate-900 data-[state=checked]:text-white"
                          />
                          {t.auth.rememberMe}
                        </label>
                        <button
                          type="button"
                          onClick={handleForgotPassword}
                          className="text-sm font-semibold text-emerald-600 transition hover:text-emerald-500"
                        >
                          {t.auth.forgotPassword}
                        </button>
                      </div>
                    ) : (
                      <div className="pt-1">
                        <label className="flex cursor-pointer items-start gap-2.5 text-sm leading-snug text-slate-600">
                          <Checkbox
                            checked={agree}
                            onCheckedChange={(checked) => {
                              setAgree(checked === true);
                              clearError('agree');
                            }}
                            className="mt-0.5 shrink-0 border-slate-300 bg-white data-[state=checked]:border-slate-900 data-[state=checked]:bg-slate-900 data-[state=checked]:text-white"
                          />
                          <span>
                            {t.auth.agreeBefore}
                            <span className="font-semibold text-slate-900">
                              {t.auth.termsOfService}
                            </span>
                            {t.auth.agreeMiddle}
                            <span className="font-semibold text-slate-900">
                              {t.auth.privacyPolicy}
                            </span>
                            {t.auth.agreeAfter}
                          </span>
                        </label>
                        {errors.agree && (
                          <p
                            role="alert"
                            className="mt-1.5 text-xs font-medium text-red-500"
                          >
                            {errors.agree}
                          </p>
                        )}
                      </div>
                    )}

                    <Button
                      type="submit"
                      disabled={loading !== null}
                      className="mt-2 h-12 w-full rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 text-[15px] font-semibold text-white shadow-[0_10px_26px_rgba(16,185,129,0.35)] transition hover:from-emerald-500 hover:to-emerald-400"
                    >
                      {loading === 'email' && (
                        <Loader2
                          className="h-4 w-4 animate-spin"
                          aria-hidden="true"
                        />
                      )}
                      {loading === 'email' ? t.auth.pleaseWait : copy.submit}
                    </Button>
                  </form>

                  {/* Switch mode */}
                  <p className="mt-6 text-center text-sm text-slate-500">
                    {copy.switchPrompt}{' '}
                    <button
                      type="button"
                      onClick={() =>
                        switchMode(mode === 'signin' ? 'signup' : 'signin')
                      }
                      className="font-semibold text-emerald-600 transition hover:text-emerald-500"
                    >
                      {copy.switchLabel}
                    </button>
                  </p>
                </div>
              </motion.div>
            </AnimatePresence>
            )}
          </main>

          <footer className="pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-6 text-center text-xs text-slate-400">
            {t.auth.footer}
          </footer>
        </div>

        {/* ── Google demo sign-in (OAuth not configured) ─────────── */}
        {googleOpen && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t.auth.googleDemoTitle}
            className="fixed inset-0 z-[80] flex items-end justify-center bg-[#020810]/70 p-4 sm:items-center"
            onClick={() => setGoogleOpen(false)}
          >
            <div
              className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-[0_30px_80px_-20px_rgba(2,12,27,0.55)]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3">
                <GoogleIcon className="h-6 w-6 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-amber-600">
                    {t.auth.googleDemoBadge}
                  </p>
                  <h2 className="truncate text-base font-bold text-slate-900">
                    {t.auth.googleDemoTitle}
                  </h2>
                </div>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-slate-500">
                {t.auth.googleDemoDesc}
              </p>
              <label
                htmlFor="google-demo-email"
                className="mt-4 block text-sm font-semibold text-slate-700"
              >
                {t.auth.googleDemoEmailLabel}
              </label>
              <Input
                id="google-demo-email"
                type="email"
                value={googleEmail}
                onChange={(e) => {
                  setGoogleEmail(e.target.value);
                  setGoogleError(null);
                }}
                placeholder="you@gmail.com"
                autoComplete="email"
                disabled={googleBusy}
                className="mt-1.5 h-11 rounded-xl border-slate-300 bg-white text-[15px] text-slate-900 focus-visible:border-emerald-500/60 focus-visible:ring-emerald-500/25"
                aria-invalid={Boolean(googleError)}
              />
              {googleError && (
                <p role="alert" className="mt-1.5 text-xs font-medium text-red-500">
                  {googleError}
                </p>
              )}
              <button
                type="button"
                onClick={() => void handleGoogleDemo()}
                disabled={googleBusy}
                className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 text-sm font-semibold text-white shadow-[0_10px_26px_rgba(16,185,129,0.35)] transition hover:from-emerald-500 hover:to-emerald-400 disabled:pointer-events-none disabled:opacity-60"
              >
                {googleBusy && (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                )}
                {t.auth.googleDemoContinue}
              </button>
            </div>
          </div>
        )}

        <span className="sr-only" aria-live="polite">
          {verifyEmail
            ? t.auth.a11yVerifyPage
            : mode === 'signin'
              ? t.auth.a11ySigninPage
              : t.auth.a11ySignupPage}
        </span>
      </motion.div>
    </div>
  );
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"
      />
    </svg>
  );
}
