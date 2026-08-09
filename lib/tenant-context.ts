import { AsyncLocalStorage } from "node:async_hooks";
import { cookies } from "next/headers.js";
import { AUTH_COOKIE, verifySessionToken, type AppSession } from "./session.ts";

const storage = new AsyncLocalStorage<AppSession>();

export function withTenant<T>(session: AppSession, fn: () => Promise<T>): Promise<T> {
  return storage.run(session, fn);
}

export async function getTenantSession(): Promise<AppSession | null> {
  const active = storage.getStore();
  if (active) return active;
  try {
    return verifySessionToken((await cookies()).get(AUTH_COOKIE)?.value);
  } catch {
    return null;
  }
}

export async function requireTenantSession(): Promise<AppSession> {
  const session = await getTenantSession();
  if (!session) throw new Error("Authenticated tenant context is required");
  return session;
}
