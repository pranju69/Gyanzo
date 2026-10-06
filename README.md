# Gyanzo — AI Learning Platform

Gyanzo is an AI-powered study platform that turns your study material into an
interactive learning experience. Upload PDFs, notes, or images and get
summaries, flashcards, quizzes, mind maps, formula sheets and more — in six
languages, with a personalized dashboard that tracks your progress.

## Features

- **AI Summaries & Explanations** — generate concise summaries and deep
  explanations from uploaded PDFs and notes
- **Flashcards** — auto-generated decks with spaced-repetition progress
  tracking
- **Quizzes** — generated quizzes with attempt history and scoring
- **Mind Maps, Formula Sheets & Exam Predictions** — structured study aids
  derived from your material
- **Vocabulary Builder** — vocab lists with learning progress
- **AI Chat** — chat with your documents, with citation support
- **Revision Notes** — key points extracted for quick review
- **Multi-language** — full UI in English, Hindi, Marathi, Spanish, French,
  German
- **Auth** — email + Google sign-in (NextAuth.js v4), email verification,
  in-app notifications

## Tech Stack

| Layer      | Technology                                    |
| ---------- | --------------------------------------------- |
| Framework  | Next.js 16 (App Router) + TypeScript          |
| Styling    | Tailwind CSS 4 + shadcn/ui (New York) + Lucide |
| Database   | PostgreSQL via Prisma ORM (Supabase)             |
| Auth       | Custom session (email-code + Google OAuth)    |
| AI         | z-ai-web-dev-sdk (LLM, VLM, TTS, ASR, image)  |
| Runtime    | Bun                                           |

## Data Model

21 Prisma models including `User`, `Subject`, `Pdf`, `Summary`,
`Explanation`, `Quiz` / `QuizAttempt`, `FlashcardDeck` /
`FlashcardProgress`, `RevisionNote`, `MindMap`, `Citation`, `VocabList` /
`VocabProgress`, `ExamPrediction`, `FormulaSheet`, `EmailVerification`,
`Notification` and more.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) v1.x
- A Google OAuth client (optional — for Google sign-in)
- An SMTP account (optional — for email verification)

### Setup

```bash
# 1. Install dependencies
bun install

# 2. Configure environment
cp .env.example .env
#    → edit .env and fill in your values

# 3. Create + seed the database schema
bun run db:push

# 4. Start the dev server
bun run dev
```

Open http://localhost:3000 in your browser.

## Environment Variables

See `.env.example`. Required keys:

| Variable              | Description                              |
| --------------------- | ---------------------------------------- |
| `DATABASE_URL`        | Supabase transaction-pooler URI (port 6543, `?pgbouncer=true&connection_limit=1`) |
| `DIRECT_URL`          | Supabase direct/session URI (port 5432) — for `prisma db push` |
| `SMTP_HOST`           | SMTP server host (email verification)    |
| `SMTP_PORT`           | SMTP server port                         |
| `SMTP_USER`           | SMTP username                            |
| `SMTP_PASS`           | SMTP password                            |
| `SMTP_FROM`           | From-address for outgoing emails         |
| `GOOGLE_CLIENT_ID`    | Google OAuth client ID                   |
| `GOOGLE_CLIENT_SECRET`| Google OAuth client secret               |
| `ZAI_BASE_URL` / `ZAI_API_KEY` | z-ai-web-dev-sdk endpoint + key (plus `ZAI_CHAT_ID`, `ZAI_TOKEN`, `ZAI_USER_ID`) |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob store token (PDF storage on serverless) |
| `NEXT_PUBLIC_DISABLE_SOCKET` | Set `1` on serverless hosts — bell falls back to polling |

## Deploy to Vercel

The app is serverless-ready: PostgreSQL database, Vercel Blob for PDF
storage, polling fallback for notifications and build-time SDK config.

1. Create a free Supabase project (supabase.com → New project).
2. Copy both connection strings from Project Settings → Database:
   - **Transaction pooler** (port 6543) → `DATABASE_URL` — append
     `?pgbouncer=true&connection_limit=1`
   - **Direct connection** (port 5432) → `DIRECT_URL`
3. Push the schema once: `npx prisma db push` with `DIRECT_URL` set.
4. Import this repo in Vercel — the build runs
   `write-zai-config.mjs && next build` automatically.
5. Set the environment variables listed above (Vercel injects
   `BLOB_READ_WRITE_TOKEN` after you create a Blob store; set
   `NEXT_PUBLIC_DISABLE_SOCKET=1`).
6. Add `https://<your-app>.vercel.app/api/auth/google/callback` to the
   authorized redirect URIs of your Google OAuth client and set
   `GOOGLE_REDIRECT_URI` accordingly.

## Scripts

| Command             | Description                        |
| ------------------- | ---------------------------------- |
| `bun run dev`       | Start dev server on port 3000      |
| `bun run build`     | Production build (standalone)      |
| `bun run start`     | Start production server            |
| `bun run lint`      | Run ESLint                         |
| `bun run db:push`   | Push Prisma schema to PostgreSQL   |
| `bun run db:generate` | Generate Prisma client           |

## Project Structure

```
src/
  app/            # App Router pages & API routes
  components/     # UI components (shadcn/ui + feature components)
  lib/            # Auth, i18n (6 locales), AI SDK helpers, db client
prisma/           # Prisma schema (SQLite)
scripts/          # Utility scripts (SMTP catcher, etc.)
mini-services/    # Standalone Bun microservices
```

## License

Private project — all rights reserved.
