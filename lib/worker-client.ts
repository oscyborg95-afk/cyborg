"use client";

type WorkerToken = { token: string; expiresAt: number; tenantId: string };

let cachedToken: WorkerToken | null = null;
let tokenRequest: Promise<WorkerToken> | null = null;

export async function getWorkerAccessToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.token;
  }
  if (!forceRefresh && tokenRequest) return (await tokenRequest).token;

  tokenRequest = fetch("/api/whatsapp/token", { cache: "no-store" })
    .then(async (response) => {
      const data = (await response.json()) as WorkerToken & { error?: string };
      if (!response.ok) throw new Error(data.error || "Could not authorize WhatsApp worker");
      cachedToken = data;
      return data;
    })
    .finally(() => {
      tokenRequest = null;
    });
  return (await tokenRequest).token;
}

export async function getWorkerConnection(forceRefresh = false): Promise<WorkerToken> {
  await getWorkerAccessToken(forceRefresh);
  if (!cachedToken) throw new Error("Could not authorize WhatsApp worker");
  return cachedToken;
}

export async function workerClientFetch(
  input: string,
  init: RequestInit = {},
  retry = true
): Promise<Response> {
  const token = await getWorkerAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(input, { ...init, headers });
  if (response.status !== 401 || !retry) return response;
  const refreshed = await getWorkerAccessToken(true);
  if (refreshed) headers.set("Authorization", `Bearer ${refreshed}`);
  return fetch(input, { ...init, headers });
}
