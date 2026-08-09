export const AUTH_COOKIE = "dc_session";

export interface AppSession {
  tenantId: string;
  userId: string;
  role: "owner" | "admin" | "member";
  expiresAt: number;
}

const encoder = new TextEncoder();

function base64UrlEncode(value: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(value).toString("base64url");
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlBytes(value: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(value).toString("base64url");
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(value, "base64url").toString("utf8");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(padded);
}

function sessionSecret(): string {
  return process.env.SESSION_SECRET || process.env.APP_PASSWORD || "";
}

async function signature(payload: string): Promise<string> {
  const secret = sessionSecret();
  if (!secret) return "";
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const bytes = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return base64UrlBytes(new Uint8Array(bytes));
}

export async function createSessionToken(
  input: Omit<AppSession, "expiresAt">,
  lifetimeMs = 30 * 24 * 60 * 60 * 1000
): Promise<{ token: string; session: AppSession }> {
  if (!sessionSecret()) throw new Error("SESSION_SECRET must be configured");
  const session = { ...input, expiresAt: Date.now() + lifetimeMs };
  const payload = base64UrlEncode(JSON.stringify(session));
  return { token: `${payload}.${await signature(payload)}`, session };
}

export async function verifySessionToken(token: string | undefined): Promise<AppSession | null> {
  if (!token || !sessionSecret()) return null;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;
  const payload = token.slice(0, separator);
  const supplied = token.slice(separator + 1);
  if (supplied !== (await signature(payload))) return null;
  try {
    const session = JSON.parse(base64UrlDecode(payload)) as AppSession;
    if (
      !session.tenantId ||
      !session.userId ||
      !["owner", "admin", "member"].includes(session.role) ||
      !Number.isSafeInteger(session.expiresAt) ||
      session.expiresAt <= Date.now()
    ) return null;
    return session;
  } catch {
    return null;
  }
}
