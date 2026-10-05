import { PrismaClient } from '@prisma/client'
import { ensureDatabaseUrl } from '@/lib/db-url'

/* Repair a sandbox-injected legacy `file:` DATABASE_URL BEFORE the client
   is constructed — module-eval order vs instrumentation.register() must
   never be able to poison the singleton with an invalid URL. No-op on
   Vercel (real postgres:// URL there). */
ensureDatabaseUrl()

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Query logging is a dev aid only — serverless logs stay clean in prod.
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['query'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
