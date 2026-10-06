import 'server-only';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import path from 'path';
import { put, del } from '@vercel/blob';

/**
 * Dual-backend PDF storage — local disk (sandbox / self-hosted) or
 * Vercel Blob (serverless, read-only filesystem).
 *
 * Mode is chosen automatically:
 *   - BLOB_READ_WRITE_TOKEN present  → Vercel Blob (row.blobUrl set)
 *   - otherwise                      → db/uploads/<storedAs> on disk
 *
 * Every reader/writer of PDF binaries MUST go through this module so the
 * same code runs in both environments without conditionals at call sites.
 */

export const UPLOAD_DIR = path.join(process.cwd(), 'db', 'uploads');

export const blobEnabled = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

/** Persist an uploaded PDF; returns its Blob URL or null when on disk. */
export async function storePdfFile(
  storedAs: string,
  data: Buffer
): Promise<string | null> {
  if (blobEnabled) {
    const blob = await put(`pdfs/${storedAs}`, data, {
      access: 'public',
      addRandomSuffix: false,
    });
    return blob.url;
  }
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(path.join(UPLOAD_DIR, storedAs), data);
  return null;
}

/** Load a stored PDF's bytes from whichever backend holds it. */
export async function loadPdfBytes(pdf: {
  storedAs: string;
  blobUrl?: string | null;
}): Promise<Buffer> {
  if (pdf.blobUrl) {
    const res = await fetch(pdf.blobUrl, {
      /* no-store: these are large binaries consumed on demand — never
         let the framework's fetch cache buffer them. */
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`blob fetch failed (${res.status}) for ${pdf.storedAs}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
  return readFile(path.join(UPLOAD_DIR, pdf.storedAs));
}

/** Best-effort delete of the stored binary (never throws). */
export async function removePdfFile(pdf: {
  storedAs: string;
  blobUrl?: string | null;
}): Promise<void> {
  if (pdf.blobUrl) {
    try {
      await del(pdf.blobUrl);
      return;
    } catch {
      /* fall through — nothing else to clean up for a blob */
    }
  }
  try {
    await unlink(path.join(UPLOAD_DIR, pdf.storedAs));
  } catch {
    /* file already gone */
  }
}
