import 'server-only';
import { db } from '@/lib/db';

/**
 * Server-side notification push (used by the feature API routes).
 *
 * 1. Persists a Notification row (SQLite) — survives reloads, powers the
 *    unread badge on next visit.
 * 2. Fire-and-forget POSTs it to the notification socket mini-service
 *    (127.0.0.1:3005) which fans it out to every open tab/device of the
 *    user in real time.
 *
 * NEVER throws — a notification failure must not break the main feature
 * (a PDF upload still succeeds even if the bell is down).
 */

const EMIT_URL = 'http://127.0.0.1:3005/emit';

export type NotificationType =
  | 'subject'
  | 'pdf'
  | 'summary'
  | 'note'
  | 'flashcards'
  | 'quiz';

export type NotificationParams = Record<string, string | number>;

export type NotificationPayload = {
  id: string;
  type: NotificationType | string;
  params: NotificationParams;
  title: string;
  body: string;
  actionNav: string;
  readAt: string | null;
  createdAt: string;
};

/** Human-readable English fallback (client localizes via `type`+`params`). */
const FALLBACK_TITLES: Record<NotificationType, (p: NotificationParams) => { title: string; body: string }> = {
  subject: (p) => ({
    title: `Subject “${p.name}” created`,
    body: 'Add PDFs to it to unlock AI study tools.',
  }),
  pdf: (p) => ({
    title: `“${p.name}” is ready to study`,
    body: `Uploaded to ${p.subject || 'your library'}.`,
  }),
  summary: (p) => ({
    title: 'Smart Summary ready',
    body: `Your ${p.length || ''} summary for ${p.subject} is generated.`.replace('  ', ' '),
  }),
  note: (p) => ({
    title: 'Revision notes ready',
    body: `Last-minute notes for ${p.subject} were generated.`,
  }),
  flashcards: (p) => ({
    title: 'Flashcard deck ready',
    body: `${p.count} cards for ${p.subject || 'your studies'} — start practising.`,
  }),
  quiz: (p) => ({
    title: 'Quiz graded',
    body: `You scored ${p.score}% on ${p.subject}.`,
  }),
};

export async function pushNotification(input: {
  email: string;
  type: NotificationType;
  params?: NotificationParams;
  actionNav?: string;
}): Promise<NotificationPayload | null> {
  const email = input.email.trim().toLowerCase();
  const params = input.params ?? {};
  const fallback = FALLBACK_TITLES[input.type]?.(params) ?? {
    title: 'Update',
    body: '',
  };

  try {
    const row = await db.notification.create({
      data: {
        userEmail: email,
        type: input.type,
        params: JSON.stringify(params),
        title: fallback.title,
        body: fallback.body,
        actionNav: input.actionNav ?? '',
      },
    });

    const payload: NotificationPayload = {
      id: row.id,
      type: row.type,
      params,
      title: row.title,
      body: row.body,
      actionNav: row.actionNav,
      readAt: null,
      createdAt: row.createdAt.toISOString(),
    };

    /* Real-time fan-out — best effort, never blocks the caller. */
    void fetch(EMIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, notification: payload }),
      signal: AbortSignal.timeout(2500),
    }).catch((error) =>
      console.warn('[notify] socket emit failed:', error?.message ?? error)
    );

    return payload;
  } catch (error) {
    console.warn('[notify] create failed:', error);
    return null;
  }
}
