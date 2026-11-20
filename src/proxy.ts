import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { ACCESS_COOKIE, hasValidAccess } from "./access";
import { DEVICE_COOKIE, DEVICE_COOKIE_OPTIONS, resolveDeviceId } from "./generation/device";

// /api/mcp checks its own secret token (Claude connectors cannot use the login cookie).
const PUBLIC_PATHS = ["/acces", "/api/acces", "/api/mcp"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (!isPublic(pathname)) {
    const allowed = await hasValidAccess(request.cookies.get(ACCESS_COOKIE)?.value);
    if (!allowed) {
      // API calls and server actions get a plain 401; page views go to the login page.
      if (pathname.startsWith("/api/") || request.method !== "GET") {
        return new NextResponse("Unauthorized", { status: 401 });
      }
      const url = request.nextUrl.clone();
      url.pathname = "/acces";
      url.search = `?next=${encodeURIComponent(pathname + search)}`;
      return NextResponse.redirect(url);
    }
  }

  if (pathname.startsWith("/api/")) return NextResponse.next();

  const { deviceId, minted } = resolveDeviceId(request.cookies.get(DEVICE_COOKIE)?.value);
  if (!minted) return NextResponse.next();
  const response = NextResponse.next();
  response.cookies.set(DEVICE_COOKIE, deviceId, DEVICE_COOKIE_OPTIONS);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
