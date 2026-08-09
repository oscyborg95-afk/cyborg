const crypto = require("crypto");

const MAX_TOKEN_LIFETIME_MS = 20 * 60 * 1000;

function sameText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signature(secret, value) {
  return crypto.createHmac("sha256", secret).update(String(value)).digest("base64url");
}

function tenantFromWorkerAccessToken(token, secret, now = Date.now()) {
  if (!secret) return null; // Local development remains zero-config.
  if (!token || sameText(token, secret)) return null;

  const pieces = token.split(".");
  if (pieces.length === 3) {
    const [tenantId, expiresText, suppliedSignature] = pieces;
    const expiresAt = Number(expiresText);
    if (
      !/^[0-9a-f-]{36}$/i.test(tenantId) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      expiresAt > now + MAX_TOKEN_LIFETIME_MS ||
      !sameText(suppliedSignature, signature(secret, `${tenantId}.${expiresAt}`))
    ) return null;
    return tenantId;
  }
  return null;
}

function verifyWorkerAccessToken(token, secret, now = Date.now(), expectedTenant = "") {
  if (!secret) return true;
  if (!token) return false;
  if (sameText(token, secret)) return true; // Trusted server-to-server request.
  const tenantId = tenantFromWorkerAccessToken(token, secret, now);
  if (tenantId) return !expectedTenant || tenantId === expectedTenant;

  // Backwards-compatible tokens are accepted only by an unscoped legacy worker.
  const separator = token.indexOf(".");
  if (separator < 1) return false;
  const expiresAt = Number(token.slice(0, separator));
  const suppliedSignature = token.slice(separator + 1);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + MAX_TOKEN_LIFETIME_MS
  ) {
    return false;
  }
  return !expectedTenant && sameText(suppliedSignature, signature(secret, expiresAt));
}

function bearerToken(header) {
  const match = String(header || "").match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

module.exports = { bearerToken, tenantFromWorkerAccessToken, verifyWorkerAccessToken };
