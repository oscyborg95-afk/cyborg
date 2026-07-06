// Server-side bridge to the headless WhatsApp worker (worker/index.js).

const WA_WORKER_URL = process.env.WA_WORKER_URL || "http://localhost:3001";

export class WorkerOfflineError extends Error {
  constructor() {
    super("WhatsApp worker is offline. Start it with: cd worker && npm start (or npm run mock)");
  }
}

export async function workerFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${WA_WORKER_URL}${path}`, { ...init, cache: "no-store" });
  } catch {
    throw new WorkerOfflineError();
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Worker error ${res.status}`);
  return data as T;
}

export function sendWhatsAppMessage(chatId: string, text: string) {
  return workerFetch<{ ok: boolean }>("/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId, text }),
  });
}
