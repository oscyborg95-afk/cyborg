import "server-only";

import { createHmac } from "node:crypto";
import { requireTenantSession } from "./tenant-context";

const TOKEN_LIFETIME_MS = 10 * 60 * 1000;

export async function mintWorkerAccessToken() {
  const secret = process.env.WORKER_API_SECRET || "";
  const { tenantId } = await requireTenantSession();
  const expiresAt = Date.now() + TOKEN_LIFETIME_MS;
  if (!secret) return { token: "", expiresAt, tenantId };
  const signature = createHmac("sha256", secret)
    .update(`${tenantId}.${expiresAt}`)
    .digest("base64url");
  return { token: `${tenantId}.${expiresAt}.${signature}`, expiresAt, tenantId };
}
