/**
 * Database URL resolver — sandbox self-healing, shared by db.ts and the
 * instrumentation hook.
 *
 * Problem this solves:
 *   This cloud sandbox injects a legacy SQLite `file:` DATABASE_URL into
 *   EVERY process (including the Next.js dev server). The Prisma schema
 *   uses the `postgresql` provider, so that URL is rejected outright with
 *   "Error validating datasource `db`: the URL must start with the
 *   protocol `postgresql://`" — which 500s every DB-backed API (subject
 *   creation, PDF registration, notifications, ...).
 *
 *   The failure is timing-dependent: `.env` (with LOCAL_PG=1) may be
 *   written AFTER the dev server booted, so `process.env.LOCAL_PG` is
 *   absent and the instrumentation guard silently bailed. Meanwhile
 *   Next.js never applies a .env value over an already-set process env
 *   var, so the broken `file:` URL kept winning.
 *
 * Fix strategy (two independent layers):
 *   1. `ensureDatabaseUrl()` runs at MODULE-EVAL time inside db.ts —
 *      before `new PrismaClient()` — so the singleton can never capture
 *      the broken URL, regardless of import order vs instrumentation.
 *   2. instrumentation-node.ts fires the same repair + starts the local
 *      Postgres whenever the `file:` URL is seen (not only when
 *      LOCAL_PG=1), so a missing/stale .env still heals itself.
 *
 * Production (Vercel) is untouched: there DATABASE_URL is a real
 * postgres:// Supabase URL and this module is a no-op.
 */

/** Local user-space Postgres started/owned by instrumentation + watchdog. */
export const LOCAL_PG_URL = 'postgresql://postgres:postgres@127.0.0.1:5433/gyanzo';

/** True when the process inherited the sandbox's legacy SQLite URL. */
export function hasLegacyFileUrl(url: string | undefined): boolean {
  return typeof url === 'string' && url.startsWith('file:');
}

/**
 * Repair the environment in place (idempotent) and return the URL the
 * Prisma client should use. Safe to call from any module, any number of
 * times — it only ever replaces a provably-invalid `file:` URL.
 */
export function ensureDatabaseUrl(): string | undefined {
  if (hasLegacyFileUrl(process.env.DATABASE_URL)) {
    process.env.DATABASE_URL = LOCAL_PG_URL;
    console.log('[db-url] repaired legacy file: DATABASE_URL →', LOCAL_PG_URL);
  }
  /* directUrl (schema) is CLI-oriented, but keep it consistent so any
     consumer resolving it never sees the broken file: URL either. */
  if (hasLegacyFileUrl(process.env.DIRECT_URL)) {
    process.env.DIRECT_URL = LOCAL_PG_URL;
  }
  return process.env.DATABASE_URL;
}
