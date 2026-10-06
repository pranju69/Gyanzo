/**
 * Materializes `.z-ai-config` for the z-ai-web-dev-sdk at BUILD time.
 *
 * The SDK only reads config from files (process.cwd() → homedir → /etc),
 * which don't exist on Vercel's serverless runtime. This script writes the
 * file from ZAI_* environment variables configured in the Vercel dashboard;
 * next.config.ts then ships it inside every serverless bundle via
 * `outputFileTracingIncludes`.
 *
 * Values come from the sandbox's /etc/.z-ai-config:
 *   ZAI_BASE_URL, ZAI_API_KEY  (required)
 *   ZAI_CHAT_ID, ZAI_TOKEN, ZAI_USER_ID  (optional extras)
 *
 * Exits 0 without writing anything when the env vars are absent — local
 * sandbox development keeps using /etc/.z-ai-config.
 */

import { writeFileSync } from 'fs';

const baseUrl = process.env.ZAI_BASE_URL;
const apiKey = process.env.ZAI_API_KEY;

if (!baseUrl || !apiKey) {
  console.log('[write-zai-config] ZAI_BASE_URL/ZAI_API_KEY not set — skipping (local dev mode)');
  process.exit(0);
}

const config = { baseUrl, apiKey };
if (process.env.ZAI_CHAT_ID) config.chatId = process.env.ZAI_CHAT_ID;
if (process.env.ZAI_TOKEN) config.token = process.env.ZAI_TOKEN;
if (process.env.ZAI_USER_ID) config.userId = process.env.ZAI_USER_ID;

writeFileSync('.z-ai-config', JSON.stringify(config, null, 2));
console.log('[write-zai-config] .z-ai-config written from environment');
