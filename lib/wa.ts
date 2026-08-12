// Server-side bridge to the headless WhatsApp worker (worker/index.js).
import { requireTenantSession } from "./tenant-context.ts";

const WA_WORKER_URL = process.env.WA_WORKER_URL || "http://localhost:3001";
const WORKER_API_SECRET = process.env.WORKER_API_SECRET || "";
const configuredWorkerTimeout = Number(process.env.WA_WORKER_TIMEOUT_MS || 10_000);
const WA_WORKER_TIMEOUT_MS = Number.isFinite(configuredWorkerTimeout)
  ? Math.max(1_000, Math.min(30_000, configuredWorkerTimeout))
  : 10_000;

export class WorkerOfflineError extends Error {
  constructor() {
    super("WhatsApp worker is offline. Start it with: cd worker && npm start (or npm run mock)");
  }
}

export class WorkerTimeoutError extends Error {
  constructor() {
    super(`WhatsApp worker did not respond within ${WA_WORKER_TIMEOUT_MS / 1000} seconds`);
  }
}

export class WorkerResponseError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export async function workerFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const callerSignal = init?.signal;
  let timedOut = false;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, WA_WORKER_TIMEOUT_MS);

  let res: Response;
  let data: { error?: string };
  try {
    const { tenantId } = await requireTenantSession();
    const headers = new Headers(init?.headers);
    if (WORKER_API_SECRET) headers.set("Authorization", `Bearer ${WORKER_API_SECRET}`);
    headers.set("x-tenant-id", tenantId);
    res = await fetch(`${WA_WORKER_URL}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      signal: controller.signal,
    });
    data = await res.json();
  } catch (error) {
    if (timedOut) throw new WorkerTimeoutError();
    if (callerSignal?.aborted) throw error;
    throw new WorkerOfflineError();
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
  if (!res.ok) {
    throw new WorkerResponseError(res.status, data.error || `Worker error ${res.status}`);
  }
  return data as T;
}

// An image riding with (or instead of) the text — base64 bytes + mime.
export interface WaOutboundMedia {
  mime: string;
  data: string;
}

// `idempotencyKey` makes a retry safe. A send that WhatsApp accepted but whose
// HTTP response we never saw (worker slower than WA_WORKER_TIMEOUT_MS) is
// retried by the notification queue; the worker recognises the key and answers
// without sending the customer a second copy.
export function sendWhatsAppMessage(
  chatId: string,
  text: string,
  media?: WaOutboundMedia,
  expectedLatestMessageId?: string,
  signal?: AbortSignal,
  idempotencyKey?: string
) {
  return workerFetch<{ ok: boolean; deduped?: boolean }>("/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId, text, media, expectedLatestMessageId, idempotencyKey }),
    signal,
  });
}

// Drives the "typing…" line on the customer's phone. Cosmetic by definition:
// a failure here must never stop the message it was announcing, so callers get
// a promise that resolves either way.
export async function sendTypingState(
  chatId: string,
  state: "composing" | "paused",
  signal?: AbortSignal
): Promise<void> {
  try {
    await workerFetch("/typing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, state }),
      signal,
    });
  } catch {
    // Ignored on purpose — see above.
  }
}

// Captured voice-note/photo bytes for a message id (base64). 404s (not
// captured, mock mode, pruned) surface as a thrown error — callers skip it.
export function fetchWaMedia(id: string) {
  return workerFetch<{ mime: string; data: string }>(`/media/${encodeURIComponent(id)}`);
}
