# Deploying Gyanzo on Netlify (fully functional)

Gyanzo is a full-stack Next.js 16 app. On Netlify, SSR pages, `/api/*`
routes and `next/image` run on Netlify Functions via the official
`@netlify/plugin-nextjs` runtime — no code changes needed, only
configuration + environment variables.

**After deploying, open `https://YOUR-SITE.netlify.app/api/health`** — it
reports exactly which dependencies are configured and which env var is
missing, so you never have to guess why a feature shows an error.

---

## 1. What each feature needs

| Feature | Depends on | Env var(s) |
| --- | --- | --- |
| Everything (sign-in, library, subjects) | Postgres database | `DATABASE_URL`, `DIRECT_URL` |
| AI chat, Smart Summary, Easy Explanation, Quiz, Flashcards, Revision Notes, Mind Map, Citation, Vocabulary, Exam Prediction, Formula Sheet, Voice Tutor, PDF page summaries | AI provider | `AI_API_KEY` (+ optional `AI_BASE_URL`, `AI_MODEL`) |
| PDF uploads & storage | Blob storage | `BLOB_READ_WRITE_TOKEN` |
| Email verification codes | Mail channel | `RESEND_API_KEY` **or** `SMTP_HOST` + `SMTP_PORT` + `SMTP_USER` + `SMTP_PASS` |
| Google sign-in | Google OAuth app | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Notification bell | Polling fallback (automatic) | nothing — realtime socket is skipped on `*.netlify.app` / `*.vercel.app` automatically |

> The sandbox-only `ZAI_BASE_URL` / `ZAI_API_KEY` vars and the
> `.z-ai-config` file are **not** needed on Netlify — `AI_API_KEY` uses the
> public OpenAI-compatible API directly.

---

## 2. Get the values

### a) Postgres — `DATABASE_URL` + `DIRECT_URL`
Reuse the same database you already use (Supabase / Neon both work):

- **Supabase** → Project settings → Database → Connection string:
  - `DATABASE_URL` = the **Transaction pooler** URL (port `6543`).
  - `DIRECT_URL` = the **Direct / session** URL (port `5432`) — used by
    `prisma db push` / migrations.
- **Neon** → Dashboard → Connection details:
  - `DATABASE_URL` = the **Pooled** connection string (`-pooler` host).
  - `DIRECT_URL` = the direct (non-pooled) connection string.

If the database is new, create the tables once from your machine:

```bash
DATABASE_URL="<pooled-url>" DIRECT_URL="<direct-url>" bunx prisma db push
```

### b) AI — `AI_API_KEY`
Create an API key on the Z.ai open platform (or any OpenAI-compatible
provider) and paste it here. Defaults used when the other two are unset:

- `AI_BASE_URL` = `https://api.z.ai/api/paas/v4`
- `AI_MODEL` = `glm-4.5-flash`

### c) PDF storage — `BLOB_READ_WRITE_TOKEN`
Gyanzo stores uploaded PDFs in **Vercel Blob** (works from any host,
including Netlify):

1. Go to your Vercel dashboard → the project's **Storage** tab → create /
   open a Blob store.
2. Copy the `BLOB_READ_WRITE_TOKEN` value (Vercel → Settings →
   Environment Variables, or the store's `.env.local` snippet).

Without it, uploads fall back to local disk, which is **ephemeral on
Netlify** (files vanish between requests) — always set this in production.

### d) Email — verification codes
Easiest: [resend.com](https://resend.com) → API key →

- `RESEND_API_KEY` = `re_…`
- `RESEND_FROM` = `Gyanzo <onboarding@resend.dev>` (or your verified domain)

Or any SMTP provider: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`.

### e) Google sign-in
1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   → your OAuth 2.0 Client → **Authorized redirect URIs** → add:
   ```
   https://YOUR-SITE.netlify.app/api/auth/google/callback
   ```
   (also keep any existing URIs; add one more line later if you attach a
   custom domain).
2. Copy the client id / secret into `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`.
   - The app **self-heals** multi-line / mislabelled paste accidents, so
     pasting the whole `.env` snippet into one field still works — but
     clean values are best.
3. Optional: `GOOGLE_BRIDGE_SECRET` (defaults to the client secret).

---

## 3. Deploy

1. Push this repository to GitHub (already at `github.com/pranju69/Gyanzo`).
2. Netlify → **Add new site → Import an existing project** → pick the repo.
3. Build settings are auto-detected from `netlify.toml`:
   - Build command: `npm run build`
   - Publish directory: `.next`
   - Plugin: `@netlify/plugin-nextjs` (installed automatically)
   - Node 22
4. **Site configuration → Environment variables** → add every variable
   from section 2. Scope them to *All scopes / Production*.
5. Click **Deploy site**.
6. When the build finishes, open:
   ```
   https://YOUR-SITE.netlify.app/api/health
   ```
   Every check should show `"configured": true, "ok": true`. Fix anything
   flagged, redeploy, and reload.

---

## 4. Notes & limits

- **Function timeout**: Netlify Functions default to **10 s** (Pro plans
  can raise it to 26 s under Site configuration → Functions). Long AI
  generations (big PDF → quiz) can exceed 10 s on the free plan — the UI
  shows a retryable error; upgrading or retrying resolves it.
- **Realtime notifications**: there is no long-lived WebSocket service on
  Netlify; the bell refreshes on window focus and every 90 s instead.
  This is automatic (host detection + `NEXT_PUBLIC_DISABLE_SOCKET=1`
  already set in `netlify.toml`).
- **Custom domains**: after attaching one, add
  `https://YOUR-DOMAIN/api/auth/google/callback` to the Google Console
  redirect URIs. No code change needed — the redirect URI derives from
  the request origin.
- **Database schema changes**: run `bunx prisma db push` with
  `DIRECT_URL` set from your machine (Netlify builds don't migrate).
- **Logs**: Netlify dashboard → your site → **Functions** tab shows the
  server-side logs for every `/api` call — useful together with
  `/api/health` when debugging.
