import { NextResponse } from "next/server";

import {
  ACCESS_COOKIE,
  ACCESS_COOKIE_OPTIONS,
  accessToken,
  safeEqual,
  safeNext,
  sitePassword,
} from "@/access";

export async function POST(request: Request) {
  const form = await request.formData();
  const given = String(form.get("password") ?? "");
  const next = safeNext(String(form.get("next") ?? "/"));
  const password = sitePassword();

  const ok = password !== null && given.length > 0 && safeEqual(
    await accessToken(given),
    await accessToken(password),
  );

  if (!ok) {
    // Slow down guessing.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const back = new URL("/acces", request.url);
    back.searchParams.set("e", password ? "1" : "config");
    if (next !== "/") back.searchParams.set("next", next);
    return NextResponse.redirect(back, 303);
  }

  const response = NextResponse.redirect(new URL(next, request.url), 303);
  response.cookies.set(ACCESS_COOKIE, await accessToken(password), ACCESS_COOKIE_OPTIONS);
  return response;
}
