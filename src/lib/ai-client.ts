import 'server-only';
import ZAI from 'z-ai-web-dev-sdk';

/**
 * Unified AI client resolver — one entry point for every AI route.
 *
 * WHY THIS EXISTS
 * The z-ai-web-dev-sdk reads its credentials from a FILE (.z-ai-config in
 * cwd / ~ / /etc) and calls an INTERNAL gateway (internal-api.z.ai → RFC1918
 * private IPs). That combination only works inside the Z sandbox:
 *   · on Vercel the config file does not exist  → ZAI.create() throws
 *     "Configuration file not found" → every AI route 500s with the generic
 *     "Something went wrong" toast;
 *   · even with a config, the internal gateway is unreachable from public
 *     hosts, so AI could NEVER work on Vercel before.
 *
 * RESOLUTION ORDER (first match wins):
 *   1. Public OpenAI-compatible provider — AI_API_KEY (+ AI_BASE_URL,
 *      optional AI_MODEL) env vars. Works on any host. Defaults to Z.ai's
 *      public GLM endpoint (https://api.z.ai/api/paas/v4, glm-4.5-flash),
 *      so a single AI_API_KEY is enough.
 *   2. The sandbox SDK (file discovery) — keeps the preview panel working
 *      exactly as before.
 *   3. Nothing → throws AiNotConfiguredError; routes answer 503
 *      { error: 'ai_not_configured' } so the UI can show an honest,
 *      actionable message instead of a generic failure.
 */

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiCompletionParams {
  messages: AiMessage[];
  /** GLM reasoning toggle — stripped for non-GLM OpenAI-compatible hosts. */
  thinking?: { type: 'enabled' | 'disabled' };
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

export interface AiCompletionResult {
  choices: Array<{ message?: { content?: string | null } }>;
  [key: string]: unknown;
}

export interface AiClient {
  chat: {
    completions: {
      create(params: AiCompletionParams): Promise<AiCompletionResult>;
    };
  };
}

/** Thrown when no AI provider is available on this host. */
export class AiNotConfiguredError extends Error {
  constructor() {
    super(
      'No AI provider configured: set AI_API_KEY (+ AI_BASE_URL) in the environment, or provide a .z-ai-config file.'
    );
    this.name = 'AiNotConfiguredError';
  }
}

interface PublicProvider {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Env-configured public provider, or null. */
function publicProvider(): PublicProvider | null {
  const apiKey = process.env.AI_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (
    process.env.AI_BASE_URL?.trim() || 'https://api.z.ai/api/paas/v4'
  ).replace(/\/+$/, '');
  const model = process.env.AI_MODEL?.trim() || 'glm-4.5-flash';
  return { baseUrl, apiKey, model };
}

/** OpenAI-compatible chat client over plain fetch (no config file needed). */
function createPublicClient(cfg: PublicProvider): AiClient {
  const isZai = /z\.ai|bigmodel/i.test(cfg.baseUrl);
  return {
    chat: {
      completions: {
        create: async (params: AiCompletionParams) => {
          const payload: Record<string, unknown> = {
            ...params,
            model: cfg.model,
          };
          // `thinking` is a GLM family extension — other providers reject it.
          if (!isZai) delete payload.thinking;

          let res: Response;
          try {
            res = await fetch(`${cfg.baseUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${cfg.apiKey}`,
              },
              body: JSON.stringify(payload),
            });
          } catch (error) {
            throw new Error(
              `LLM network error: ${error instanceof Error ? error.message : String(error)}`
            );
          }
          // Message text is matched by the shared retry helper (ai.ts).
          if (res.status === 429) {
            throw new Error('LLM status 429 too many requests');
          }
          if (!res.ok) {
            const detail = (await res.text().catch(() => '')).slice(0, 300);
            throw new Error(
              `LLM status ${res.status}${detail ? `: ${detail}` : ''}`
            );
          }
          return (await res.json()) as AiCompletionResult;
        },
      },
    },
  };
}

/** The sandbox SDK client, resolved once (null = file discovery failed). */
let sdkClient: AiClient | null = null;
let sdkTried = false;

/**
 * Resolve an AI client or throw AiNotConfiguredError.
 * Cached per lambda instance; cheap to call per request.
 */
export async function getAi(): Promise<AiClient> {
  const pub = publicProvider();
  if (pub) return createPublicClient(pub);

  if (!sdkTried) {
    sdkTried = true;
    try {
      sdkClient = (await ZAI.create()) as unknown as AiClient;
    } catch {
      sdkClient = null;
    }
  }
  if (sdkClient) return sdkClient;

  throw new AiNotConfiguredError();
}
