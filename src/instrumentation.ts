/**
 * Next.js instrumentation hook — runs once per server instance.
 *
 * Kept runtime-agnostic: the actual work lives in instrumentation-node.ts,
 * imported only when running on the Node.js runtime (Edge builds would
 * otherwise fail to bundle node:fs / node:child_process).
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const node = await import('./instrumentation-node');
    await node.register();
  }
}
