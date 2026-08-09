import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { bearerToken, tenantFromWorkerAccessToken, verifyWorkerAccessToken } = require("../worker/access.js");

test("worker access accepts the server secret and valid short-lived tokens", () => {
  const secret = "test-secret";
  const now = 1_800_000_000_000;
  const expiresAt = now + 60_000;
  const signature = createHmac("sha256", secret)
    .update(String(expiresAt))
    .digest("base64url");

  assert.equal(verifyWorkerAccessToken(secret, secret, now), true);
  assert.equal(verifyWorkerAccessToken(`${expiresAt}.${signature}`, secret, now), true);
  assert.equal(verifyWorkerAccessToken(`${expiresAt}.wrong`, secret, now), false);
  assert.equal(verifyWorkerAccessToken(`${now - 1}.${signature}`, secret, now), false);
  assert.equal(verifyWorkerAccessToken("", secret, now), false);
});

test("worker access stays zero-config locally and parses bearer headers", () => {
  assert.equal(verifyWorkerAccessToken("", ""), true);
  assert.equal(bearerToken("Bearer abc123"), "abc123");
  assert.equal(bearerToken("Basic abc123"), "");
});

test("tenant worker tokens cannot cross WhatsApp accounts", () => {
  const secret = "worker-secret";
  const tenantA = "11111111-1111-4111-8111-111111111111";
  const tenantB = "22222222-2222-4222-8222-222222222222";
  const now = Date.now();
  const expiresAt = now + 60_000;
  const signature = createHmac("sha256", secret)
    .update(`${tenantA}.${expiresAt}`)
    .digest("base64url");
  const token = `${tenantA}.${expiresAt}.${signature}`;
  assert.equal(tenantFromWorkerAccessToken(token, secret, now), tenantA);
  assert.equal(verifyWorkerAccessToken(token, secret, now, tenantA), true);
  assert.equal(verifyWorkerAccessToken(token, secret, now, tenantB), false);
});
