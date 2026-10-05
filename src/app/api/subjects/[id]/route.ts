import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

/**
 * Single subject — scoped to the signed-in user's email (owner-only).
 *
 * PATCH  /api/subjects/<id>  { email, name?, color? } → { ok, subject }
 * DELETE /api/subjects/<id>?email=<email>            → { ok }
 *
 * Deleting a subject never destroys documents: PDFs keep their
 * historical subjectName string, they simply regroup under "All
 * subjects" in the library filter.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_COLORS = new Set(['emerald', 'orange', 'teal', 'amber', 'violet', 'rose']);

type Ctx = { params: Promise<{ id: string }> };

/** Resolve + validate the owner email from JSON body or query string. */
function ownerEmail(request: Request, body?: unknown): string {
  if (body && typeof body === 'object') {
    const e = String((body as { email?: unknown }).email ?? '').trim().toLowerCase();
    if (e) return e;
  }
  const { searchParams } = new URL(request.url);
  return searchParams.get('email')?.trim().toLowerCase() ?? '';
}

export async function PATCH(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    /* validation below handles the rest */
  }

  const email = ownerEmail(request, body);
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : undefined;
  const color = typeof body.color === 'string' ? body.color.trim() : undefined;

  if (name !== undefined && (name.length < 1 || name.length > 80)) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }
  if (color !== undefined && !ALLOWED_COLORS.has(color)) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }
  if (name === undefined && color === undefined) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    /* Read first so we only ever mutate the owner's row. */
    const existing = await db.subject.findUnique({ where: { id } });
    if (!existing || existing.userEmail !== email) {
      return NextResponse.json({ ok: false, error: 'notFound' }, { status: 404 });
    }

    const subject = await db.subject.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(color !== undefined ? { color } : {}),
      },
    });

    return NextResponse.json({
      ok: true,
      subject: {
        id: subject.id,
        name: subject.name,
        color: ALLOWED_COLORS.has(subject.color) ? subject.color : 'emerald',
        createdAt: subject.createdAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('[subjects/PATCH] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

export async function DELETE(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const email = ownerEmail(request);
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    /* Read first so we only delete (and notify about) the owner's row. */
    const subject = await db.subject.findUnique({ where: { id } });
    if (!subject || subject.userEmail !== email) {
      return NextResponse.json({ ok: false, error: 'notFound' }, { status: 404 });
    }

    await db.subject.delete({ where: { id } });

    /* No bell notification for deletes — the action is user-initiated and
       confirmed by the client toast. */

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[subjects/DELETE] database error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}
