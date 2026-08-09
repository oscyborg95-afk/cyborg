import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, createSessionToken } from "@/lib/session";
import { authenticateTenant } from "@/lib/tenants";

export async function POST(req: NextRequest) {
  if (!process.env.SESSION_SECRET && !process.env.APP_PASSWORD) {
    return NextResponse.json({ ok: true });
  }

  const body = await req.json().catch(() => ({}));
  const email = typeof body.email === "string" && body.email.trim()
    ? body.email
    : process.env.ADMIN_EMAIL || "owner@daily-cart.local";
  if (typeof body.password !== "string") {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
  }
  const membership = await authenticateTenant(email, body.password);
  if (!membership) return NextResponse.json({ error: "Wrong email or password" }, { status: 401 });

  const { token, session } = await createSessionToken({
    tenantId: membership.tenant.id,
    userId: membership.userId,
    role: membership.role,
  });

  const res = NextResponse.json({ ok: true, tenant: { id: membership.tenant.id, name: membership.tenant.name, slug: membership.tenant.slug } });
  res.cookies.set(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(session.expiresAt),
  });
  return res;
}
