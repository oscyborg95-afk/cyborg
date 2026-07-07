// Shared between proxy.ts (the gate) and /api/login (the cookie setter).
// The cookie holds a SHA-256 of the password, so rotating APP_PASSWORD
// invalidates every signed-in browser. Web Crypto keeps it runtime-agnostic.

export const AUTH_COOKIE = "dc_auth";

export async function authToken(password: string): Promise<string> {
  const bytes = new TextEncoder().encode(`daily-cart-auth:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
