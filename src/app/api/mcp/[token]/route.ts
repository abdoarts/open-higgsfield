import { NextResponse } from "next/server";

import { safeEqual } from "@/access";
import { handleMcpMessage } from "@/mcp/server";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

async function authorized(ctx: Ctx): Promise<boolean> {
  const secret = process.env.MCP_SECRET;
  if (!secret || secret.length < 24) return false;
  const { token } = await ctx.params;
  return safeEqual(token ?? "", secret);
}

export async function POST(request: Request, ctx: Ctx) {
  if (!(await authorized(ctx))) return new NextResponse("Not found", { status: 404 });

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 },
    );
  }

  if (Array.isArray(payload)) {
    const responses = (await Promise.all(payload.map(handleMcpMessage))).filter(Boolean);
    return responses.length ? NextResponse.json(responses) : new NextResponse(null, { status: 202 });
  }

  const response = await handleMcpMessage(payload);
  if (!response) return new NextResponse(null, { status: 202 });
  return NextResponse.json(response);
}

// Stateless server: no server-initiated stream, no sessions to delete.
export async function GET(_request: Request, ctx: Ctx) {
  if (!(await authorized(ctx))) return new NextResponse("Not found", { status: 404 });
  return new NextResponse("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}

export async function DELETE(_request: Request, ctx: Ctx) {
  if (!(await authorized(ctx))) return new NextResponse("Not found", { status: 404 });
  return new NextResponse("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}
