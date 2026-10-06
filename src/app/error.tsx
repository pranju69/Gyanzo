'use client';

import RobotFallback from '@/components/robot-fallback';

/**
 * Route-segment error boundary (App Router convention).
 * Catches render/data errors anywhere below the root layout and shows
 * the Gyanzo robot instead of a raw crash. `reset` re-renders the
 * failed segment without a full page reload.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Surface the real cause in the console for debugging.
  console.error('[app/error boundary]', error);

  return (
    <RobotFallback
      title="Something went wrong"
      message="The server hit an unexpected error. Your saved work is safe — try again."
      reset={reset}
    />
  );
}
