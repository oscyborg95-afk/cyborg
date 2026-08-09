import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, verifySessionToken } from "./lib/session";

// Single-operator auth gate. Set APP_PASSWORD in .env.local (or the platform
// env) and every page + API route requires a login; leave it unset and the app
// stays open (local dev).

export async function proxy(req: NextRequest) {
  const authConfigured = Boolean(process.env.SESSION_SECRET || process.env.APP_PASSWORD);
  if (!authConfigured) return NextResponse.next();

  const { pathname } = req.nextUrl;
  // External courier callbacks cannot carry the operator's browser cookie.
  // This route performs its own constant-time COURIER_WEBHOOK_SECRET check.
  if (
    pathname === "/login" ||
    pathname === "/api/login" ||
    pathname === "/api/signup" ||
    pathname === "/api/courier/webhook" ||
    pathname === "/api/agent/inbound" ||
    pathname === "/api/tracking/cron" ||
    pathname === "/api/radar/cron"
  ) {
    return NextResponse.next();
  }

  const session = await verifySessionToken(req.cookies.get(AUTH_COOKIE)?.value);
  if (session) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized — log in first" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next's static assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
