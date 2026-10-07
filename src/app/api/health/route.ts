import { NextResponse } from 'next/server';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { db } from '@/lib/db';
import { googleCredentials } from '@/lib/google-credentials';
import { activeMailChannel, isMailConfigured } from '@/lib/mailer';
import { blobEnabled } from '@/lib/pdf-store';

export const dynamic = 'force-dynamic';

/**
 * Deployment self-check — one GET that reports whether every external
 * dependency Gyanzo depends on is configured and reachable on THIS host.
 *
 * Open https://<your-site>/api/health after deploying (Netlify, Vercel,
 * self-hosted…) and every misconfiguration is visible at a glance, so a
 * feature failing in the UI can be traced to its missing env var in
 * seconds instead of guesswork.
 *
 * Never returns secret values — booleans and harmless suffixes only.
 */

interface Check {
  configured: boolean;
  ok?: boolean;
  detail?: string;
  error?: string;
}

async function checkDatabase(): Promise<Check> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    return { configured: false, ok: false, error: 'DATABASE_URL is not set' };
  }
  const started = Date.now();
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('query timed out after 6s')), 6000)
      ),
    ]);
    return {
      configured: true,
      ok: true,
      detail: `query ok in ${Date.now() - started}ms`,
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      detail: `failed after ${Date.now() - started}ms`,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkAi(): Check {
  if (process.env.AI_API_KEY?.trim()) {
    return {
      configured: true,
      ok: true,
      detail: `public provider ${process.env.AI_BASE_URL?.trim() || 'https://api.z.ai/api/paas/v4'} · model ${process.env.AI_MODEL?.trim() || 'glm-4.5-flash'}`,
    };
  }
  // Sandbox SDK file discovery (cwd → homedir → /etc) — preview panel only.
  const sandboxConfig = [
    path.resolve(process.cwd(), '.z-ai-config'),
    path.join(homedir(), '.z-ai-config'),
    '/etc/.z-ai-config',
  ].some((p) => existsSync(p));
  if (sandboxConfig) {
    return { configured: true, ok: true, detail: 'sandbox SDK config file' };
  }
  return {
    configured: false,
    ok: false,
    error:
      'AI_API_KEY is not set — AI chat, summaries, explanations, quizzes, flashcards, revision notes and every other AI feature will return "ai_not_configured"',
  };
}

function checkBlob(): Check {
  if (blobEnabled) {
    return { configured: true, ok: true, detail: 'Vercel Blob storage' };
  }
  return {
    configured: false,
    ok: false,
    error:
      'BLOB_READ_WRITE_TOKEN is not set — PDF uploads fall back to local disk, which is EPHEMERAL on serverless hosts (files vanish between requests)',
  };
}

function checkMail(): Check {
  if (!isMailConfigured()) {
    return {
      configured: false,
      ok: false,
      error:
        'no mail channel — email verification codes cannot be sent (set RESEND_API_KEY, or SMTP_HOST + SMTP_USER + SMTP_PASS)',
    };
  }
  return { configured: true, ok: true, detail: `${activeMailChannel()} channel` };
}

function checkGoogleOAuth(): Check {
  const creds = googleCredentials();
  if (!creds) {
    return {
      configured: false,
      ok: false,
      error:
        'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing or unparsable — Google sign-in is disabled',
    };
  }
  return {
    configured: true,
    ok: true,
    detail: `client id …${creds.clientId.slice(-12)} (redirect URI auto-derives from the request origin)`,
  };
}

export async function GET() {
  const [database] = await Promise.all([checkDatabase()]);
  const ai = checkAi();
  const blob = checkBlob();
  const mail = checkMail();
  const googleOAuth = checkGoogleOAuth();

  const checks = { database, ai, pdfStorage: blob, mail, googleOAuth };
  // Critical = the app cannot function at all without these.
  const criticalOk = Boolean(database.ok && ai.ok);

  return NextResponse.json(
    {
      app: 'gyanzo',
      status: criticalOk ? 'ok' : 'degraded',
      time: new Date().toISOString(),
      runtime: {
        node: process.version,
        env: process.env.NODE_ENV ?? null,
        host: process.env.NETLIFY
          ? 'netlify'
          : process.env.VERCEL
            ? 'vercel'
            : 'self-hosted',
      },
      realtime: {
        socketDisabled:
          process.env.NEXT_PUBLIC_DISABLE_SOCKET === '1' ||
          Boolean(process.env.VERCEL || process.env.NETLIFY),
        detail:
          'notification bell uses focus/interval polling when the socket service is unavailable',
      },
      checks,
      hint: criticalOk
        ? undefined
        : 'Set the missing variables in your hosting dashboard, then redeploy and reload this page.',
    },
    { status: 200 }
  );
}
