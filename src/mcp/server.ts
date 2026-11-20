/* Minimal stateless MCP server (Streamable HTTP, JSON responses) exposing the
   studio's catalog and generation pipeline as tools. It reuses the same model
   catalog, settings validation and platform mapping as the web studio, and
   bills the Higgsfield Cloud key stored server-side in HF_API_KEY. */

import { MODELS, getModel, parseSettings } from "@/generation/catalog";
import type { GenerationPlane, MediaItem, MediaRole } from "@/generation/catalog/types";
import { createPlatformClient } from "@/generation/platform";
import type { GenerationStatus } from "@/generation/platform";
import { toPlatform } from "@/generation/to-platform";

import { CATALOG, CATALOG_FETCHED_AT, findMode, searchCatalog, summarize } from "./hf-catalog";

const SERVER_INFO = { name: "open-higgsfield", version: "2.0.0" };
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const FINAL = new Set(["completed", "failed", "nsfw", "canceled", "cancelled", "error"]);
const MAX_WAIT_SECONDS = 50;

type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: unknown };
type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

class ToolError extends Error {}

const ROLE_KEYS: MediaRole[] = ["start", "end", "reference", "video", "audio"];

const TOOLS = [
  {
    name: "search_models",
    title: "Chercher dans tout le catalogue Higgsfield",
    description: `Search the FULL Higgsfield Cloud API catalog (${CATALOG.length} endpoints: every image and video model and mode — Kling 4.0, Seedance 2.5, Genjutsu, Cinema Studio, AI Influencer, Marketing Studio, Seedream, Wan, MiniMax, LTX, Grok, Recraft, Ideogram, Soul…). Returns endpoint ids, price, accepted media (image/video/audio) and parameter names. Then call get_model for the full parameter schema and run_model to execute. Filter by free text (e.g. 'kling edit', 'motion transfer'), output ('image'|'video') and accepts ('image'|'video'|'audio' — e.g. accepts:'audio' for audio-driven / lip-sync style videos).`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to match in the endpoint, model name, company or description." },
        output: { type: "string", enum: ["image", "video"] },
        accepts: { type: "string", enum: ["image", "video", "audio"], description: "Only endpoints that accept this kind of media URL as input." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_model",
    title: "Détails d'un endpoint",
    description:
      "Full details for one Higgsfield endpoint from search_models: JSON input schema (every parameter, enum values, defaults, limits, which are required), price, and the official usage notes (e.g. how to fetch presets, draft/finalize workflows). Read this before run_model when unsure of the parameters.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint: { type: "string", description: "Endpoint id, e.g. 'kling-video/v4.0/image-to-video'." },
        include_docs: { type: "boolean", description: "Include the official usage notes (default true)." },
      },
      required: ["endpoint"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "run_model",
    title: "Lancer n'importe quel modèle Higgsfield",
    description:
      "Run ANY Higgsfield Cloud API endpoint with a raw JSON input matching its schema (see get_model), billed to the owner's API credits. Media inputs are public https URLs in the fields the schema defines (image_url, image_urls, video_urls, audio_url, audio_urls…). Waits up to wait_seconds (default 50) and returns the full platform response (images, video, or other outputs); if still running, returns a request_id for get_request. Cost is per the endpoint's price — confirm with the user before long or high-resolution videos.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint: { type: "string", description: "Endpoint id from search_models, e.g. 'bytedance/seedance-2.5/reference-to-video'." },
        input: { type: "object", additionalProperties: true, description: "JSON body for the endpoint, per its input schema." },
        wait_seconds: { type: "number", minimum: 0, maximum: MAX_WAIT_SECONDS },
      },
      required: ["endpoint", "input"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "get_request",
    title: "Suivre une requête (réponse complète)",
    description:
      "Status of any request started with run_model or generate, returning the raw platform response (all output URLs and fields). Optionally waits up to wait_seconds (default 50) for completion.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        wait_seconds: { type: "number", minimum: 0, maximum: MAX_WAIT_SECONDS },
      },
      required: ["request_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "cancel_request",
    title: "Annuler une requête",
    description: "Cancel a request that is still queued (only possible before processing starts).",
    inputSchema: {
      type: "object",
      properties: { request_id: { type: "string" } },
      required: ["request_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "api_get",
    title: "Lecture d'une ressource de l'API",
    description:
      "Read-only GET on the Higgsfield API for helper resources that some endpoints' docs require, e.g. 'marketing-studio/image/presets?size=50' to list current preset ids. Path is relative to the API root.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path with optional query string." } },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "list_models",
    title: "Lister les modèles",
    description:
      "Studio subset only (38 models with simplified settings, used by `generate`). For the full Higgsfield catalog use search_models / run_model. List the image and video models available in the OpenHiggsfield studio, with the settings each one accepts (allowed values and defaults) and how many media inputs of each role it takes (start/end frame, reference images, source videos, audio). Call this before `generate` when unsure which model or settings to use.",
    inputSchema: {
      type: "object",
      properties: {
        surface: { type: "string", enum: ["image", "video"], description: "Only list image or video models." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "generate",
    title: "Générer une image ou une vidéo",
    description:
      "Generate an image or a video with a Higgsfield model, billed to the studio owner's Higgsfield Cloud API credits. Waits up to `wait_seconds` (default 50) for the result; if it is not finished yet, returns a request_id to pass to `get_status`. Images usually finish within the wait; videos usually need get_status. Settings use the keys from list_models (e.g. aspectRatio, resolution, duration, batchSize as a string). Media inputs must be public https URLs. LIP SYNC / TALKING CHARACTER: use model 'seedance-2.5' (or 'seedance-2'), pass the face as reference_image_urls (or start_image_url) and the speech as audio_urls; say in the prompt that the person in the image speaks the provided audio, and set settings.duration to cover the audio length. Only Seedance models accept audio.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model id from list_models, e.g. 'soul-2' (image) or 'seedance-2.5' (video). Defaults to 'soul-2'." },
        prompt: { type: "string", description: "What to generate." },
        settings: {
          type: "object",
          description: "Model settings by key, e.g. {\"aspectRatio\":\"16:9\",\"resolution\":\"1080p\"}. Omitted keys use the model defaults.",
          additionalProperties: true,
        },
        start_image_url: { type: "string", description: "First frame / input image URL (image-to-video)." },
        end_image_url: { type: "string", description: "Last frame image URL." },
        reference_image_urls: { type: "array", items: { type: "string" }, description: "Reference image URLs." },
        video_urls: { type: "array", items: { type: "string" }, description: "Source video URLs (edit, extend, motion control)." },
        audio_urls: { type: "array", items: { type: "string" }, description: "Audio URLs (speech for lip sync, music, sound). Seedance models only." },
        wait_seconds: { type: "number", minimum: 0, maximum: MAX_WAIT_SECONDS, description: "How long to wait for the result before returning a request_id. Default 50." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "get_status",
    title: "Suivre une génération",
    description:
      "Check a generation started with `generate`, optionally waiting up to `wait_seconds` (default 50) for it to finish. Returns the image or video URLs once completed. Result URLs are hosted by Higgsfield and may expire, so download anything worth keeping.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        wait_seconds: { type: "number", minimum: 0, maximum: MAX_WAIT_SECONDS },
      },
      required: ["request_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
] as const;

export async function handleMcpMessage(message: unknown): Promise<JsonRpcResponse | null> {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  const req = message as JsonRpcRequest;
  const isNotification = req.id === undefined;
  if (isNotification) return null;
  const id = req.id ?? null;

  try {
    switch (req.method) {
      case "initialize": {
        const requested = (req.params as { protocolVersion?: string } | undefined)?.protocolVersion;
        const protocolVersion =
          requested && SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions:
              `Personal Higgsfield connector on the owner's Cloud API credits. FULL catalog (${CATALOG.length} endpoints, snapshot ${CATALOG_FETCHED_AT.slice(0, 10)}): search_models → get_model (schema) → run_model (any endpoint, raw JSON input) → get_request until completed; cancel_request, api_get for helper resources (presets). Simplified tools kept for the studio's own 38 models: list_models / generate / get_status. Audio-driven video (speech, lip-sync style): search_models with accepts:'audio' (e.g. wan/v2.7/image-to-video with audio_url, Seedance/Wan reference-to-video with audio_urls). Media inputs must be public https URLs.`,
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
      case "tools/call": {
        const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        return { jsonrpc: "2.0", id, result: await callTool(params.name ?? "", params.arguments ?? {}) };
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${req.method}` } };
    }
  } catch (caught) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: caught instanceof Error ? caught.message : String(caught) },
    };
  }
}

async function callTool(name: string, args: Record<string, unknown>) {
  try {
    switch (name) {
      case "search_models":
        return text(searchModels(args));
      case "get_model":
        return text(getModelDetails(args));
      case "run_model":
        return text(await runModel(args));
      case "get_request":
        return text(await getRequest(args));
      case "cancel_request":
        return text(await cancelRequest(args));
      case "api_get":
        return text(await apiGet(args));
      case "list_models":
        return text(listModels(args));
      case "generate":
        return text(await generate(args));
      case "get_status":
        return text(await getStatus(args));
      default:
        throw new ToolError(`Unknown tool: ${name}`);
    }
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return { content: [{ type: "text", text: `Error: ${friendly(message)}` }], isError: true };
  }
}

function friendly(message: string): string {
  if (message === "not_enough_credits") return "not_enough_credits — the Higgsfield Cloud account behind this studio has no API credits left (top up at cloud.higgsfield.ai).";
  return message;
}

function text(value: unknown) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

/* ---------- full catalog tools ---------- */

const PATH_RE = /^[a-z0-9][a-z0-9._\-/]*(\?[\w.\-=&%,]*)?$/i;

function credentials() {
  const apiKey = process.env.HF_API_KEY?.trim();
  const baseUrl = process.env.HF_API_BASE_URL?.replace(/\/$/, "");
  if (!apiKey) throw new ToolError("HF_API_KEY is not configured on the server (add it in Vercel → Settings → Environment Variables).");
  if (!baseUrl) throw new ToolError("HF_API_BASE_URL is not configured on the server.");
  return { apiKey, baseUrl };
}

async function hf(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const clean = path.replace(/^\/+/, "");
  if (!PATH_RE.test(clean) || clean.includes("..")) throw new ToolError(`Invalid path '${path}'`);
  const { apiKey, baseUrl } = credentials();
  const response = await fetch(`${baseUrl}/${clean}`, {
    method,
    headers: {
      Authorization: `Key ${apiKey}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const textBody = await response.text();
  let payload: unknown = textBody;
  try {
    payload = textBody ? JSON.parse(textBody) : null;
  } catch {
    /* keep text */
  }
  console.info("[mcp] platform", { method, path: clean, status: response.status });
  if (!response.ok) {
    const detail = (payload as { detail?: unknown } | null)?.detail;
    const message = typeof detail === "string" ? friendly(detail) : JSON.stringify(payload);
    throw new ToolError(`Higgsfield API ${response.status} on ${clean}: ${message}`);
  }
  return payload;
}

function searchModels(args: Record<string, unknown>) {
  const results = searchCatalog({
    query: typeof args.query === "string" ? args.query : undefined,
    output: typeof args.output === "string" ? args.output : undefined,
    accepts: typeof args.accepts === "string" ? args.accepts : undefined,
  }).map(summarize);
  return { count: results.length, catalog_snapshot: CATALOG_FETCHED_AT, results };
}

function getModelDetails(args: Record<string, unknown>) {
  const endpoint = typeof args.endpoint === "string" ? args.endpoint : "";
  const mode = findMode(endpoint);
  if (!mode) {
    const guess = searchCatalog({ query: endpoint.split(/[/\s-]+/).filter((w) => w.length > 2).slice(0, 2).join(" ") })
      .slice(0, 8)
      .map((m) => m.endpoint);
    throw new ToolError(`Unknown endpoint '${endpoint}'. Close matches: ${guess.join(", ") || "none — use search_models"}`);
  }
  const includeDocs = args.include_docs !== false;
  return {
    ...summarize(mode),
    availability: mode.availability,
    input_schema: mode.schema,
    ...(includeDocs && mode.docs ? { usage_notes: mode.docs } : {}),
  };
}

function finalStatus(payload: unknown): string {
  const status = (payload as { status?: unknown } | null)?.status;
  return typeof status === "string" ? status : "unknown";
}

async function pollRaw(requestId: string, seconds: number): Promise<unknown> {
  const deadline = Date.now() + seconds * 1000;
  let payload = await hf("GET", `requests/${encodeURIComponent(requestId)}/status`);
  while (!FINAL.has(finalStatus(payload)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    payload = await hf("GET", `requests/${encodeURIComponent(requestId)}/status`);
  }
  return payload;
}

function rawResult(payload: unknown, extra: Record<string, unknown> = {}) {
  const status = finalStatus(payload);
  const requestId = (payload as { request_id?: unknown } | null)?.request_id;
  const urls = [...JSON.stringify(payload ?? null).matchAll(/"(https:\/\/[^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/\/requests\//.test(u));
  const summary =
    status === "completed"
      ? `Completed. Outputs:\n${urls.join("\n") || "(see response)"}\n(Higgsfield-hosted URLs may expire — download what you want to keep.)`
      : FINAL.has(status)
        ? `Ended with status '${status}'.`
        : `Still ${status}. Call get_request with request_id ${String(requestId)} to keep waiting.`;
  return { summary, ...extra, response: payload };
}

async function runModel(args: Record<string, unknown>) {
  const endpoint = typeof args.endpoint === "string" ? args.endpoint.replace(/^\/+|\/+$/g, "") : "";
  if (!endpoint) throw new ToolError("endpoint is required");
  if (endpoint.startsWith("requests/")) throw new ToolError("Use get_request / cancel_request for requests.");
  const input = args.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ToolError("input must be a JSON object");
  const mode = findMode(endpoint);
  const required = mode?.schema?.required ?? [];
  const missing = required.filter((key) => (input as Record<string, unknown>)[key] === undefined);
  if (missing.length) throw new ToolError(`Missing required field(s) for ${endpoint}: ${missing.join(", ")}. See get_model.`);
  const queued = await hf("POST", endpoint, input);
  const requestId = (queued as { request_id?: unknown } | null)?.request_id;
  if (typeof requestId !== "string") return rawResult(queued, { endpoint });
  const payload = await pollRaw(requestId, waitSeconds(args.wait_seconds));
  return rawResult(payload, {
    endpoint,
    request_id: requestId,
    price: mode?.price ?? null,
    ...(mode ? {} : { note: "Endpoint not in the catalog snapshot — sent as-is." }),
  });
}

async function getRequest(args: Record<string, unknown>) {
  const requestId = typeof args.request_id === "string" ? args.request_id.trim() : "";
  if (!requestId) throw new ToolError("request_id is required");
  return rawResult(await pollRaw(requestId, waitSeconds(args.wait_seconds)), { request_id: requestId });
}

async function cancelRequest(args: Record<string, unknown>) {
  const requestId = typeof args.request_id === "string" ? args.request_id.trim() : "";
  if (!requestId) throw new ToolError("request_id is required");
  return { request_id: requestId, response: await hf("POST", `requests/${encodeURIComponent(requestId)}/cancel`) };
}

async function apiGet(args: Record<string, unknown>) {
  const path = typeof args.path === "string" ? args.path.trim().replace(/^https:\/\/[^/]+\//, "") : "";
  if (!path) throw new ToolError("path is required");
  return { path, response: await hf("GET", path) };
}

function listModels(args: Record<string, unknown>) {
  const surface = args.surface === "image" || args.surface === "video" ? args.surface : null;
  return MODELS.filter((m) => !surface || m.surface === surface).map((m) => ({
    id: m.id,
    label: m.label,
    surface: m.surface,
    media_inputs: m.roles,
    settings: m.settings,
  }));
}

function client() {
  const apiKey = process.env.HF_API_KEY;
  const baseUrl = process.env.HF_API_BASE_URL;
  if (!apiKey) throw new ToolError("HF_API_KEY is not configured on the server (add it in Vercel → Settings → Environment Variables).");
  if (!baseUrl) throw new ToolError("HF_API_BASE_URL is not configured on the server.");
  return createPlatformClient({ apiKey: apiKey.trim(), baseUrl });
}

function strings(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => {
    if (typeof item !== "string" || !/^https:\/\//i.test(item)) throw new ToolError(`${field} must be https URLs`);
    return item;
  });
}

async function generate(args: Record<string, unknown>) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) throw new ToolError("prompt is required");
  const modelId = typeof args.model === "string" && args.model ? args.model : "soul-2";
  let model;
  try {
    model = getModel(modelId);
  } catch {
    throw new ToolError(`Unknown model '${modelId}'. Call list_models to see valid ids.`);
  }

  const rawSettings =
    args.settings && typeof args.settings === "object" && !Array.isArray(args.settings)
      ? { ...(args.settings as Record<string, unknown>) }
      : {};
  // Accept batchSize as a number too.
  if (typeof rawSettings.batchSize === "number") rawSettings.batchSize = String(rawSettings.batchSize);
  let settings: Record<string, unknown>;
  try {
    settings = parseSettings(model, rawSettings);
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : String(caught);
    throw new ToolError(`${detail} for model ${model.id}. Allowed: ${JSON.stringify(model.settings)}`);
  }

  const byRole: Record<MediaRole, string[]> = {
    start: strings(args.start_image_url, "start_image_url"),
    end: strings(args.end_image_url, "end_image_url"),
    reference: strings(args.reference_image_urls, "reference_image_urls"),
    video: strings(args.video_urls, "video_urls"),
    audio: strings(args.audio_urls, "audio_urls"),
  };
  const media: GenerationPlane["media"] = {};
  for (const role of ROLE_KEYS) {
    const list = byRole[role];
    if (!list.length) continue;
    const max = model.roles[role] ?? 0;
    if (!max) throw new ToolError(`Model ${model.id} does not accept ${role} media.`);
    if (list.length > max) throw new ToolError(`Model ${model.id} accepts at most ${max} ${role} input(s).`);
    media[role] = list.map((url, i): MediaItem => ({ id: `${role}-${i}`, url, role }));
  }

  const plane: GenerationPlane = { model: model.id, prompt: { text: prompt }, media, settings };
  const { path, body } = toPlatform(plane);
  const platform = client();
  const queued = await platform.submit(path, body);
  const status = await waitFor(platform, queued.requestId, waitSeconds(args.wait_seconds));
  return describe(status, { model: model.id, surface: model.surface, settings });
}

async function getStatus(args: Record<string, unknown>) {
  const requestId = typeof args.request_id === "string" ? args.request_id.trim() : "";
  if (!requestId) throw new ToolError("request_id is required");
  const platform = client();
  return describe(await waitFor(platform, requestId, waitSeconds(args.wait_seconds)));
}

function waitSeconds(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return MAX_WAIT_SECONDS;
  return Math.max(0, Math.min(MAX_WAIT_SECONDS, value));
}

async function waitFor(
  platform: ReturnType<typeof createPlatformClient>,
  requestId: string,
  seconds: number,
): Promise<GenerationStatus> {
  const deadline = Date.now() + seconds * 1000;
  let status = await platform.status(requestId);
  while (!FINAL.has(status.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    status = await platform.status(requestId);
  }
  return status;
}

function describe(status: GenerationStatus, extra: Record<string, unknown> = {}) {
  const images = status.images?.map((img) => img.url) ?? [];
  const video = status.video?.url;
  const done = status.status === "completed";
  const lines: string[] = [];
  if (done) {
    lines.push("Generation completed.");
    images.forEach((url, i) => lines.push(`Image ${i + 1}: ${url}`));
    if (video) lines.push(`Video: ${video}`);
    lines.push("(Higgsfield-hosted URLs may expire — download what you want to keep.)");
  } else if (FINAL.has(status.status)) {
    lines.push(`Generation ended with status '${status.status}'.`);
  } else {
    lines.push(`Still ${status.status}. Call get_status with request_id ${status.requestId} to keep waiting.`);
  }
  return {
    summary: lines.join("\n"),
    request_id: status.requestId,
    status: status.status,
    ...(images.length ? { images } : {}),
    ...(video ? { video } : {}),
    ...(status.error !== undefined ? { error: status.error } : {}),
    ...extra,
  };
}
