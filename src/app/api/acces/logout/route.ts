import { NextResponse } from "next/server";

import { ACCESS_COOKIE, ACCESS_COOKIE_OPTIONS } from "@/access";

export async function GET(request: Request) {
  const response = NextResponse.redirect(new URL("/acces", request.url), 303);
  response.cookies.set(ACCESS_COOKIE, "", { ...ACCESS_COOKIE_OPTIONS, maxAge: 0 });
  return response;
}
