import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, createSessionToken } from "@/lib/session";
import { createTenantAccount } from "@/lib/tenants";

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_SIGNUP !== "true") {
    return NextResponse.json({ error: "New account signup is currently disabled" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  try {
    const membership = await createTenantAccount({
      email: String(body.email || ""),
      password: String(body.password || ""),
      businessName: String(body.businessName || ""),
    });
    const { token, session } = await createSessionToken({
      tenantId: membership.tenant.id,
      userId: membership.userId,
      role: membership.role,
    });
    const response = NextResponse.json({ ok: true, tenant: membership.tenant }, { status: 201 });
    response.cookies.set(AUTH_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: new Date(session.expiresAt),
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create account";
    const status = /already exists/.test(message) ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
