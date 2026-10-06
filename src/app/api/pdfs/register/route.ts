import { NextResponse } from 'next/server';
import { list } from '@vercel/blob';
import { PDFDocument } from 'pdf-lib';
import { db } from '@/lib/db';
import { pushNotification } from '@/lib/notify';
import { blobEnabled } from '@/lib/pdf-store';

/**
 * Register a PDF that the browser uploaded DIRECTLY to Vercel Blob.
 *
 * Body (JSON): { email, name, subject?, url, pathname }
 *
 * The client-direct upload bypasses the serverless request body entirely,
 * so this endpoint is the server's only chance to validate what landed.
 * Because @vercel/blob's list() is scoped to OUR store via
 * BLOB_READ_WRITE_TOKEN, confirming the URL exists in that listing proves
 * the file is ours — a client cannot register an arbitrary URL.
 *
 * Validation chain:
 *   1. email/name/subject sanity limits (same as multipart route)
 *   2. pathname shape: pdfs/<uuid>.pdf (as issued by /api/pdfs/upload)
 *   3. token-scoped list() finds the exact URL in our store
 *   4. first bytes are %PDF- (magic header, read via Range and cancelled)
 *   5. page count best-effort for files ≤ 50 MB (same as multipart route)
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PATHNAME_RE = /^pdfs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;
const PAGE_COUNT_LIMIT = 50 * 1024 * 1024;

export async function POST(request: Request) {
  if (!blobEnabled) {
    return NextResponse.json({ ok: false, error: 'noBlob' }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as
    | {
        email?: unknown;
        name?: unknown;
        subject?: unknown;
        url?: unknown;
        pathname?: unknown;
      }
    | null;

  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const rawName = typeof body?.name === 'string' ? body.name : '';
  const subject = typeof body?.subject === 'string' ? body.subject.trim() : '';
  const url = typeof body?.url === 'string' ? body.url : '';
  const pathname = typeof body?.pathname === 'string' ? body.pathname : '';

  if (!EMAIL_RE.test(email) || !rawName) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }
  if (!rawName.toLowerCase().endsWith('.pdf')) {
    return NextResponse.json({ ok: false, error: 'notPdf' }, { status: 400 });
  }
  if (!url.startsWith('https://') || !PATHNAME_RE.test(pathname)) {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    /* 3. The file must exist in OUR blob store (token-scoped listing). */
    const { blobs } = await list({ prefix: pathname, limit: 5 });
    const found = blobs.find((b) => b.url === url);
    if (!found) {
      return NextResponse.json({ ok: false, error: 'notFound' }, { status: 404 });
    }
    /* NOTE: @vercel/blob list() does not always expose contentType — only
       reject when it IS present and clearly not a PDF (the real gate is
       the %PDF- magic check below plus the upload token's
       allowedContentTypes). */
    if (
      found.contentType &&
      !found.contentType.toLowerCase().includes('pdf')
    ) {
      return NextResponse.json({ ok: false, error: 'notPdf' }, { status: 400 });
    }

    /* 4. Magic header check — read 5 bytes, then cancel the stream so a
       huge file costs almost nothing to validate. Aborted after 5 s so a
       slow CDN hop can never hang registration (the list() ownership
       check above is the real security gate). */
    try {
      const head = await fetch(url, {
        headers: { Range: 'bytes=0-4' },
        cache: 'no-store',
        signal: AbortSignal.timeout(5_000),
      });
      const reader = head.body?.getReader();
      if (reader) {
        const { value } = await Promise.race([
          reader.read(),
          new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 5_000)),
        ]);
        await reader.cancel().catch(() => {});
        const magic =
          value === 'timeout' ? '' : Buffer.from(value!).toString('latin1');
        if (value !== 'timeout' && !magic.startsWith('%PDF-')) {
          return NextResponse.json({ ok: false, error: 'notPdf' }, { status: 400 });
        }
      } else {
        await head.body?.cancel().catch(() => {});
      }
    } catch {
      /* Unreachable blob, range unsupported, or timeout — the list() check
         above already proved ownership; keep the flow resilient. */
    }

    /* 5. Best-effort page count, mirroring the multipart route. Capped at
       25 s total — a missing page count never blocks the upload. */
    let pages = 0;
    if (found.size <= PAGE_COUNT_LIMIT) {
      try {
        pages = await Promise.race([
          (async () => {
            const res = await fetch(url, {
              cache: 'no-store',
              signal: AbortSignal.timeout(20_000),
            });
            if (!res.ok) return 0;
            const buf = Buffer.from(await res.arrayBuffer());
            const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
            return doc.getPageCount();
          })(),
          new Promise<number>((r) => setTimeout(() => r(0), 25_000)),
        ]);
      } catch (error) {
        console.warn('[pdfs/register] page count failed for', rawName, error);
      }
    }

    const storedAs = pathname.split('/').pop() as string;

    try {
      const pdf = await db.pdf.create({
        data: {
          userEmail: email,
          name: rawName.slice(0, 120),
          subjectName: subject ? subject.slice(0, 80) : null,
          size: found.size,
          pages,
          status: 'ready',
          storedAs,
          blobUrl: url,
        },
      });

      void pushNotification({
        email,
        type: 'pdf',
        params: {
          name: pdf.name,
          subject: pdf.subjectName ?? '',
          pages: pdf.pages,
        },
        actionNav: 'pdf-library',
      });

      return NextResponse.json({
        ok: true,
        pdf: {
          id: pdf.id,
          name: pdf.name,
          subjectName: pdf.subjectName,
          size: pdf.size,
          pages: pdf.pages,
          status: pdf.status,
          createdAt: pdf.createdAt.toISOString(),
        },
      });
    } catch (error) {
      console.error('[pdfs/register] database error:', error);
      return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
    }
  } catch (error) {
    console.error('[pdfs/register] verification error:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}
