import { NextResponse } from 'next/server';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { blobEnabled } from '@/lib/pdf-store';

/**
 * Client-direct upload token endpoint (Vercel Blob).
 *
 * The browser calls `upload()` from `@vercel/blob/client` with
 * `handleUploadUrl: '/api/pdfs/upload'`. That library first POSTs here to
 * get a short-lived, content-type- and size-scoped token, then streams the
 * file STRAIGHT to the Blob store — bypassing the ~4.5 MB serverless
 * request-body limit that made every textbook-sized PDF fail with
 * FUNCTION_PAYLOAD_TOO_LARGE.
 *
 * After the bytes land, the client POSTs /api/pdfs/register to create the
 * database row (verified against our store via a token-scoped listing).
 *
 * Only active when BLOB_READ_WRITE_TOKEN exists (Vercel). In disk mode the
 * classic multipart POST /api/pdfs handles everything locally.
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Mirrors the original disk-mode streaming cap (500 MB). */
const MAX_DIRECT_UPLOAD_BYTES = 500 * 1024 * 1024;

export async function POST(request: Request): Promise<NextResponse> {
  if (!blobEnabled) {
    return NextResponse.json({ ok: false, error: 'noBlob' }, { status: 400 });
  }

  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  try {
    const json = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ['application/pdf'],
        maximumSizeInBytes: MAX_DIRECT_UPLOAD_BYTES,
        addRandomSuffix: false,
      }),
      /* Row creation happens in /api/pdfs/register after the client's
         upload() resolves — no upload-completed callback needed. */
    });
    return NextResponse.json(json);
  } catch (error) {
    console.error('[pdfs/upload/POST] token generation failed:', error);
    return NextResponse.json({ ok: false, error: 'server' }, { status: 500 });
  }
}
