// github-core-clone-01 — a standalone, GitHub-compatible git forge.
//
// Lifecycle in the trial pod:
//   1. bind an ephemeral port of our own (never 8080 — that is the env's),
//   2. register it with $MAKEFUN_ENV_URL/register (first register wins),
//   3. serve until $MAKEFUN_ENV_URL/done answers {"done": true},
//   4. exit 0.
//
// With no MAKEFUN_ENV_URL set, serve on $PORT (default 3101) for local
// testing instead. No model calls, no outside services: the whole forge runs
// in this one process.

import { createApp } from './src/app.ts';
import { Store } from './src/store.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const POLL_INTERVAL_MS = 500;
const REGISTER_ATTEMPTS = 20;

async function postJson(url: string, payload: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, text: await res.text() };
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { method: 'GET' });
  return res.json() as Promise<unknown>;
}

async function main(): Promise<void> {
  const store = new Store();
  const server = createApp(store);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('could not determine the listening port');
  }
  const port = address.port;

  if (ENV_URL === '') {
    // Local mode: move to a stable port for testing.
    const localPort = Number.parseInt(process.env.PORT ?? '3101', 10);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(localPort, '127.0.0.1', () => resolve());
    });
    console.log(`github-core-clone-01 listening on http://127.0.0.1:${localPort}`);
    return;
  }

  // Register with the environment, retrying briefly on transient failures.
  const registerUrl = `${ENV_URL.replace(/\/$/, '')}/register`;
  let registered = false;
  let lastError = '';
  for (let attempt = 0; attempt < REGISTER_ATTEMPTS && !registered; attempt += 1) {
    try {
      const { status, text } = await postJson(registerUrl, { port });
      if (status >= 200 && status < 300) {
        registered = true;
      } else {
        lastError = `HTTP ${status}: ${text}`;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (!registered) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!registered) {
    throw new Error(`failed to register with the environment: ${lastError}`);
  }

  // Serve until the environment says it is done.
  const doneUrl = `${ENV_URL.replace(/\/$/, '')}/done`;
  for (;;) {
    try {
      const body = await getJson(doneUrl) as { done?: unknown };
      if (body !== null && typeof body === 'object' && body.done === true) break;
    } catch {
      // The env answers at once; a failed poll is transient — keep serving.
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
