'use client';

import Link from 'next/link';

/**
 * RobotFallback — the branded "something broke" screen shown by
 * app/error.tsx and app/global-error.tsx (i.e. whenever the app/server
 * dies mid-render). Shows the Gyanzo robot mascot + a way forward.
 *
 * Deliberately dependency-free (no i18n/UI-kit hooks): global-error renders
 * WITHOUT the root layout, so this must survive with plain HTML+Tailwind.
 */
export default function RobotFallback({
  title = 'Something went wrong',
  message = 'The server hit an unexpected error. Your saved work is safe — try again.',
  retry,
  reset,
}: {
  title?: string;
  message?: string;
  retry?: () => void;
  /** Next.js error-boundary reset (re-renders the failed segment). */
  reset?: () => void;
}) {
  const tryAgain = retry ?? reset;

  return (
    <div
      aria-live="assertive"
      role="alert"
      className="fixed inset-0 z-[9999] flex min-h-screen flex-col items-center justify-center bg-[#eefdf4] px-6 text-center font-brand"
    >
      <img
        src="/robot.png"
        alt="Gyanzo robot"
        width={168}
        height={168}
        className="mb-6 h-28 w-28 animate-[float_3s_ease-in-out_infinite] object-contain drop-shadow-[0_12px_28px_rgba(2,153,102,0.25)] sm:h-40 sm:w-40"
      />

      <h1 className="max-w-md text-2xl font-bold tracking-tight text-[#0b1639] sm:text-3xl">
        {title}
      </h1>
      <p className="mt-3 max-w-sm text-sm leading-relaxed text-[#5d6d80] sm:text-base">
        {message}
      </p>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        {tryAgain && (
          <button
            type="button"
            onClick={tryAgain}
            className="rounded-full bg-[#029966] px-7 py-3 text-sm font-semibold text-white shadow-[0_8px_24px_rgba(2,153,102,0.35)] transition hover:bg-[#028155]"
          >
            Try again
          </button>
        )}
        <Link
          href="/"
          className="rounded-full bg-white px-7 py-3 text-sm font-semibold text-[#0b1639] shadow-[0_6px_18px_rgba(6,95,70,0.10)] transition hover:shadow-[0_8px_24px_rgba(6,95,70,0.18)]"
        >
          Go home
        </Link>
      </div>

      <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-10px); }
        }
      `}</style>
    </div>
  );
}
