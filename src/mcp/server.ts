/* Minimal stateless MCP server (Streamable HTTP, JSON responses) exposing the
   studio's catalog and generation pipeline as tools. It reuses the same model
   catalog, settings validation and platform mapping as the web studio, and
   bills the Higgsfield Cloud key stored server-side in HF_API_KEY. */

import { MODELS, getModel, parseSettings } from "@/generation/catalog";
import type { GenerationPlane, MediaItem, MediaRole } from "@/generation/catalog/types";
import { createPlatformClient } from "@/generation/platform";
import type { GenerationStatus } from "@/generation/platform";
import { toPlatform } from "@/generation/to-platform";

const SERVER_INFO = { name: "open-higgsfield", version: "1.0.0" };
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
    name: "list_models",
    title: "Lister les modèles",
    description:
      "List the image and video models available in the OpenHiggsfield studio, with the settings each one accepts (allowed values and defaults) and how many media inputs of each role it takes (start/end frame, reference images, source videos, audio). Call this before `generate` when unsure which model or settings to use.",
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
              "OpenHiggsfield studio: generate images and videos with Higgsfield models on the owner's Cloud API credits. Use list_models to pick a model and settings, generate to start, get_status to follow long runs (videos).",
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
