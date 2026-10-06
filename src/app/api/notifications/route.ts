import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

/**
 * Notifications API — backs the dashboard bell.
 *
 * GET    /api/notifications?email=<email>          → { ok, notifications, unreadCount }
 * POST   /api/notifications { email, id?, all? }   → mark one/all read → { ok, unreadCount }
 * DELETE /api/notifications?email=<email>&id=<id>  → delete one (id) or all (no id) → { ok, unreadCount }
 *
 * Rows are CREATED server-side by the feature routes via src/lib/notify.ts
 * (persist + real-time socket fan-out); this route only reads/updates them.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LIST_LIMIT = 30;

type Row = {
  id: string;
  type: string;
  params: string;
  title: string;
  body: string;
  actionNav: string;
  readAt: Date | null;
  createdAt: Date;
};

function serialize(row: Row) {
  let params: Record<string, string | number> = {};
  try {
    const parsed = JSON.parse(row.params) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      params = parsed as Record<string, string | number>;
    }
  } catch {
    /* keep empty params */
  }
  return {
    id: row.id,
    type: row.type,
    params,
    title: row.title,
    body: row.body,
    actionNav: row.actionNav,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    const [rows, unread] = await Promise.all([
      db.notification.findMany({
        where: { userEmail: email },
        orderBy: { createdAt: 'desc' },
        take: LIST_LIMIT,
      }),
      db.notification.count({ where: { userEmail: email, readAt: null } }),
    ]);
    return NextResponse.json({
      ok: true,
      notifications: rows.map(serialize),
      unreadCount: unread,
    });
  } catch (error) {
    console.error('[notifications/GET] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: { email?: unknown; id?: unknown; all?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  const email =
    typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const all = body.all === true;

  if (!EMAIL_RE.test(email) || (!id && !all)) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    await db.notification.updateMany({
      where: { userEmail: email, ...(all ? {} : { id }), readAt: null },
      data: { readAt: new Date() },
    });
    const unreadCount = await db.notification.count({
      where: { userEmail: email, readAt: null },
    });
    return NextResponse.json({ ok: true, unreadCount });
  } catch (error) {
    console.error('[notifications/POST] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get('email') ?? '').trim().toLowerCase();
  const id = (searchParams.get('id') ?? '').trim();

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    await db.notification.deleteMany({
      where: { userEmail: email, ...(id ? { id } : {}) },
    });
    const unreadCount = await db.notification.count({
      where: { userEmail: email, readAt: null },
    });
    return NextResponse.json({ ok: true, unreadCount });
  } catch (error) {
    console.error('[notifications/DELETE] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}
