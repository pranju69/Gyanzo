'use client';

import RobotFallback from '@/components/robot-fallback';

/**
 * Global error boundary (App Router convention).
 * Last resort when the ROOT LAYOUT itself crashes — renders its own
 * <html>/<body> because the normal layout is unavailable (this is the
 * closest a web app gets to a "server died" screen). The robot mascot
 * and favicon still identify the app, and the browser caches the
 * favicon so it stays visible in the tab even when the server is down.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  console.error('[app/global-error boundary]', error);

  return (
    <html lang="en" suppressHydrationWarning>
      <body style={{ margin: 0, backgroundColor: '#eefdf4' }}>
        <RobotFallback
          title="Gyanzo is unavailable"
          message="The server went down unexpectedly. We're on it — try again in a moment."
          reset={reset}
        />
        {/* Favicon independent of the (crashed) metadata pipeline */}
        <link rel="icon" href="/favicon.ico" sizes="any" />
      </body>
    </html>
  );
}
