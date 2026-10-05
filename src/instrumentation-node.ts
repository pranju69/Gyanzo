/**
 * Node.js-only instrumentation: sandbox local-Postgres bootstrap.
 *
 * Fires when the process inherited the sandbox's legacy SQLite `file:`
 * DATABASE_URL (unconditionally invalid for the postgres provider) or
 * when LOCAL_PG=1 is set in the local .env:
 *   1. Repair the environment — this sandbox exports a legacy SQLite
 *      `file:` DATABASE_URL into every process, which the postgres-
 *      provider Prisma client rejects outright. The trigger is the URL
 *      ITSELF (not .env), because .env may be written after this server
 *      booted and Next.js never overrides an already-set process env var.
 *   2. Start the user-space Postgres via `pg_ctl start` (daemonized).
 *      A daemonized postmaster is re-parented to PID 1 and survives this
 *      sandbox's background-process reaper; directly-attached children
 *      and `nohup`/`setsid` keepers do not.
 *
 * db.ts additionally runs ensureDatabaseUrl() at module-eval time so the
 * Prisma singleton can never capture the broken URL first.
 *
 * On Vercel everything below is a no-op — production uses Supabase via
 * DATABASE_URL/DIRECT_URL and never inherits a file: URL.
 */

const PG_CTL = 'node_modules/@embedded-postgres/linux-x64/native/bin/pg_ctl';
const DATA_DIR = 'db/pgdata';
const PORT = 5433;
const HOST = '127.0.0.1';
const LOCAL_URL = `postgresql://postgres:postgres@${HOST}:${PORT}/gyanzo`;

/** True when something accepts TCP connections on HOST:PORT. */
async function portReady(timeoutMs = 1500): Promise<boolean> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const sock = net.connect({ host: HOST, port: PORT });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

async function waitUntilReady(maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await portReady(800)) return true;
    await new Promise((res) => setTimeout(res, 400));
  }
  return false;
}

export async function register() {
  /* Trigger on the broken URL ITSELF (sandbox always injects it) or the
     explicit LOCAL_PG=1 flag — .env timing must never matter. */
  const legacyUrl = process.env.DATABASE_URL?.startsWith('file:') ?? false;
  if (!legacyUrl && process.env.LOCAL_PG !== '1') return;

  // 1. Repair a legacy inherited DATABASE_URL (idempotent shared helper).
  const { ensureDatabaseUrl } = await import('./lib/db-url');
  if (ensureDatabaseUrl() === LOCAL_URL) {
    console.log('[instrumentation] DATABASE_URL pointed at the local sandbox Postgres');
  }

  // 2. Start the local server (daemonized via pg_ctl).
  const { existsSync, readFileSync, unlinkSync } = await import('node:fs');
  if (!existsSync(PG_CTL) || !existsSync(`${DATA_DIR}/PG_VERSION`)) {
    console.log('[instrumentation] local postgres binaries/data not present — skipping');
    return;
  }

  if (await waitUntilReady(1500)) {
    console.log('[instrumentation] local postgres already running on :5433/gyanzo');
    return;
  }

  // A SIGKILLed previous instance leaves a stale postmaster.pid; drop it
  // when the recorded pid is provably dead, otherwise postgres refuses to
  // start ("lock file already exists").
  const pidFile = `${DATA_DIR}/postmaster.pid`;
  try {
    if (existsSync(pidFile)) {
      const pid = parseInt(readFileSync(pidFile, 'utf8').split('\n')[0].trim(), 10);
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (!alive) {
        unlinkSync(pidFile);
        console.log('[instrumentation] removed stale postmaster.pid');
      }
    }
  } catch {
    /* best effort */
  }

  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve) => {
    execFile(
      PG_CTL,
      ['-D', DATA_DIR, '-l', `${DATA_DIR}/pg.log`, '-w', '-t', '20', '-o', `-p ${PORT}`, 'start'],
      { cwd: process.cwd() },
      (err, stdout, stderr) => {
        const out = `${stdout}${stderr}`;
        if (err && !/already running/i.test(out)) {
          console.warn('[instrumentation] local postgres start failed:', out.slice(0, 300));
        }
        resolve();
      }
    );
  });

  if (await waitUntilReady(15_000)) {
    console.log('[instrumentation] local postgres ready on :5433/gyanzo');
  } else {
    console.warn('[instrumentation] local postgres not reachable — see db/pgdata/pg.log');
  }
}
