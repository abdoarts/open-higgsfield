/* Private access gate. One shared password (SITE_PASSWORD, set in Vercel)
   unlocks the studio; the session cookie holds an HMAC of a fixed label keyed
   by that password, so changing the password signs everyone out. */

export const ACCESS_COOKIE = "ohf_access";
export const ACCESS_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export const ACCESS_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: ACCESS_MAX_AGE,
};

const LABEL = "openhiggsfield-access-v1";

export function sitePassword(): string | null {
  const value = process.env.SITE_PASSWORD;
  return value && value.length > 0 ? value : null;
}

export async function accessToken(password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(LABEL));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hasValidAccess(cookieValue: string | undefined): Promise<boolean> {
  const password = sitePassword();
  if (!password || !cookieValue) return false;
  return safeEqual(cookieValue, await accessToken(password));
}

/** Only same-site relative paths, so the login page cannot bounce visitors elsewhere. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (raw.startsWith("/acces") || raw.startsWith("/api/acces")) return "/";
  return raw;
}
