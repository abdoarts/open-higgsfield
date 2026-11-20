/* Full Higgsfield Cloud API catalog (every endpoint with its JSON input schema),
   snapshotted from open.higgsfield.ai by `pnpm catalog`. */

import raw from "./hf-catalog.json";

export type CatalogMode = {
  endpoint: string;
  family: string;
  mode: string | null;
  company: string | null;
  output: string | null;
  availability: string;
  price: string | null;
  description?: string | null;
  docs?: string | null;
  schema?: {
    type?: string;
    required?: string[];
    properties?: Record<string, Record<string, unknown>>;
    [key: string]: unknown;
  } | null;
};

const data = raw as unknown as { fetched_at: string; modes: CatalogMode[] };

export const CATALOG_FETCHED_AT = data.fetched_at;
export const CATALOG: readonly CatalogMode[] = data.modes;

export function findMode(endpoint: string): CatalogMode | undefined {
  const clean = endpoint.replace(/^https?:\/\/[^/]+\//, "").replace(/^\/+|\/+$/g, "");
  return CATALOG.find((m) => m.endpoint === clean);
}

const MEDIA_HINTS: Record<string, RegExp> = {
  image: /image/,
  video: /video/,
  audio: /audio/,
};

/** Which kinds of media URL fields an endpoint accepts (image_url(s), video_urls, audio_url…). */
export function acceptedMedia(mode: CatalogMode): string[] {
  const props = Object.keys(mode.schema?.properties ?? {});
  const kinds = new Set<string>();
  for (const key of props) {
    if (!/_urls?$/.test(key) && key !== "medias") continue;
    for (const [kind, re] of Object.entries(MEDIA_HINTS)) if (re.test(key)) kinds.add(kind);
  }
  return [...kinds];
}

export function summarize(mode: CatalogMode) {
  const props = mode.schema?.properties ?? {};
  return {
    endpoint: mode.endpoint,
    name: [mode.family, mode.mode].filter(Boolean).join(" · "),
    company: mode.company,
    output: mode.output,
    price: mode.price,
    accepts_media: acceptedMedia(mode),
    required: mode.schema?.required ?? [],
    params: Object.keys(props),
    description: mode.description ?? null,
  };
}

export function searchCatalog(opts: { query?: string; output?: string; accepts?: string }) {
  const words = (opts.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return CATALOG.filter((m) => {
    if (opts.output && m.output !== opts.output) return false;
    if (opts.accepts && !acceptedMedia(m).includes(opts.accepts)) return false;
    if (!words.length) return true;
    const hay = `${m.endpoint} ${m.family} ${m.mode ?? ""} ${m.company ?? ""} ${m.description ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
