'use client';

import { useCallback, useState } from 'react';
import {
  ArrowRight,
  Bot,
  FolderOpen,
  GraduationCap,
  Languages,
  Upload,
} from 'lucide-react';
import OnboardingFlow from '@/components/onboarding/onboarding-flow';
import ProfileSetup, { type ProfileUser } from '@/components/onboarding/profile-setup';
import AuthFlow, { type AuthMode } from '@/components/auth/auth-flow';
import LanguageSwitcher from '@/components/language-switcher';
import { useLanguage } from '@/lib/i18n';

/**
 * Gyanzo landing page — shown right after the intro finishes.
 * Light mint background (#eefdf4), Poppins type, dark navy headings and
 * green accents — matching the brand design reference. Fully localized
 * via useLanguage(); the header pill switches the language for the whole
 * app (persisted in a cookie).
 *
 * After a new account verifies its email the host's `onVerified` runs
 * (→ Dashboard). Without a host handler the profile-setup onboarding
 * opens, as before.
 */
export default function LandingPage({
  onVerified,
}: {
  onVerified?: (user: { name: string; email: string }) => void;
}) {
  const { t } = useLanguage();
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>('signin');
  // Set after a new account verifies its email → shows the profile-setup
  // onboarding (Photo → Academic → Goals → Ready).
  const [setupUser, setSetupUser] = useState<ProfileUser | null>(null);

  const startLearning = () => setOnboardingOpen(true);
  const openAuth = (mode: AuthMode) => {
    setAuthMode(mode);
    setAuthOpen(true);
  };
  const closeAuth = useCallback(() => setAuthOpen(false), []);

  // Onboarding finished ("Get Started 🎓" on slide 4) → send the user to
  // the Sign Up page to create their account.
  const handleOnboardingComplete = () => {
    setOnboardingOpen(false);
    openAuth('signup');
  };

  const seeHowItWorks = () =>
    document
      .getElementById('features')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const FEATURES = [
    { icon: Bot, title: t.landing.f1Title, desc: t.landing.f1Desc },
    { icon: Upload, title: t.landing.f2Title, desc: t.landing.f2Desc },
    { icon: FolderOpen, title: t.landing.f3Title, desc: t.landing.f3Desc },
    { icon: Languages, title: t.landing.f4Title, desc: t.landing.f4Desc },
  ];

  return (
    <div className="font-brand flex min-h-screen flex-col bg-[#eefdf4] text-slate-900">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="border-b border-emerald-900/[0.06]">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <a href="#" className="flex items-center gap-2.5" aria-label={t.landing.a11yHome}>
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#05b87b] shadow-[0_2px_8px_rgba(5,184,123,0.35)]">
              <GraduationCap className="h-5 w-5 text-white" strokeWidth={2.2} />
            </span>
            <span className="text-lg font-bold tracking-tight text-slate-950">Gyanzo</span>
          </a>

          <div className="flex items-center gap-3 sm:gap-5">
            <LanguageSwitcher variant="light" />
            <button
              type="button"
              onClick={() => openAuth('signin')}
              className="rounded-full bg-[#04b87a] px-4 py-2 text-sm font-semibold text-white shadow-[0_2px_10px_rgba(4,184,122,0.35)] transition hover:bg-[#03a56b] sm:px-5"
            >
              {t.landing.getStarted}
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* ── Hero ─────────────────────────────────────────────── */}
        <section className="px-4 pb-14 pt-14 text-center sm:pb-20 sm:pt-24">
          <h1 className="mx-auto max-w-4xl text-4xl font-bold leading-[1.12] tracking-tight text-slate-950 sm:text-5xl md:text-6xl lg:text-[64px]">
            {t.landing.heroLine1}
            <br />
            <span className="text-[#06b074]">{t.landing.heroLine2}</span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-sm leading-relaxed text-[#5d6d80] sm:text-base">
            {t.landing.heroDesc}
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={startLearning}
              className="inline-flex items-center gap-2 rounded-full bg-[#029966] px-7 py-3 text-sm font-semibold text-white shadow-[0_8px_24px_rgba(2,153,102,0.35)] transition hover:bg-[#028155]"
            >
              {t.landing.startLearning}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={seeHowItWorks}
              className="inline-flex items-center rounded-full bg-white px-7 py-3 text-sm font-semibold text-[#0b1639] shadow-[0_6px_18px_rgba(6,95,70,0.10)] transition hover:shadow-[0_8px_24px_rgba(6,95,70,0.15)]"
            >
              {t.landing.seeHow}
            </button>
          </div>

          <p className="mt-6 text-xs text-slate-500">
            {t.landing.motto}{' '}
            <span aria-hidden="true" className="text-[#f776b1]">
              &#10024;
            </span>
          </p>
        </section>

        {/* ── Features ─────────────────────────────────────────── */}
        <section id="features" className="mx-auto w-full max-w-6xl scroll-mt-8 px-4 py-14 sm:py-20">
          <h2 className="text-center text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
            {t.landing.featuresTitle}
          </h2>

          <div className="mt-10 grid grid-cols-1 gap-4 sm:mt-14 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <article
                key={f.title}
                className="rounded-[10px] bg-white p-6 shadow-[0_4px_16px_rgba(6,95,70,0.08)] transition-all duration-200 hover:shadow-[0_8px_28px_rgba(6,95,70,0.13)]"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#e8fdf5] text-[#0aa473]">
                  <f.icon className="h-6 w-6" aria-hidden="true" />
                </div>
                <h3 className="mt-6 text-base font-semibold text-[#000029]">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[#8792ab]">{f.desc}</p>
              </article>
            ))}
          </div>
        </section>

        {/* ── CTA ──────────────────────────────────────────────── */}
        <section className="mx-auto w-full max-w-6xl px-4 py-12 sm:py-16">
          <div className="rounded-3xl bg-gradient-to-br from-[#029a69] via-[#0dae79] to-[#07d2bd] px-6 py-16 text-center sm:py-20">
            <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl lg:text-[40px]">
              {t.landing.ctaTitle}
            </h2>
            <p className="mt-3 text-sm text-emerald-50/90 sm:text-base">
              {t.landing.ctaDesc}
            </p>
            <button
              type="button"
              onClick={startLearning}
              className="mt-8 inline-flex items-center gap-2 rounded-full bg-white px-7 py-3 text-sm font-semibold text-[#058250] shadow-[0_8px_24px_rgba(2,80,55,0.28)] transition hover:bg-emerald-50"
            >
              {t.landing.startLearning}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </section>
      </main>

      {/* ── Footer (sticky to bottom on short viewports) ────────── */}
      <footer className="mt-auto py-8 pb-[max(2rem,env(safe-area-inset-bottom))] text-center text-xs text-[#7b8e9d]">
        {t.landing.footer}
      </footer>

      {/* ── Onboarding (Start learning free) ───────────────────── */}
      {onboardingOpen && (
        <OnboardingFlow
          onClose={() => setOnboardingOpen(false)}
          onComplete={handleOnboardingComplete}
        />
      )}

      {/* ── Sign In / Sign Up (Get started) ────────────────────── */}
      {authOpen && (
        <AuthFlow
          initialMode={authMode}
          onClose={closeAuth}
          onVerified={(u) => {
            // Email verified → hand the identity to the host (Dashboard)
            // or fall back to the profile-setup onboarding.
            setAuthOpen(false);
            if (onVerified) {
              onVerified(u);
            } else {
              setSetupUser(u);
            }
          }}
        />
      )}

      {/* ── Profile setup (after email verification) ───────────── */}
      {setupUser && (
        <ProfileSetup
          user={setupUser}
          onClose={() => setSetupUser(null)}
          onComplete={() => setSetupUser(null)}
        />
      )}
    </div>
  );
}
