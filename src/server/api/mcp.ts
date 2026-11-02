/**
 * MCP server (streamable HTTP transport, stateless, JSON responses only).
 *
 * One POST = one JSON-RPC message (batches accepted for 2025-03-26 clients). No sessions, no SSE streams:
 * every request is authenticated independently with an API key (`Authorization: Bearer rk_live_…`), so the
 * server scales horizontally with no affinity. Tools are filtered by the key's scopes.
 */
import "server-only";
import { z } from "zod";
import { logger } from "@/server/lib/logger";
import { readTextCapped } from "./body";
import { ApiError, authenticate, bearerToken, errorResponse } from "./http";
import { hasScope, type ApiPrincipal, type ApiScope } from "./keys";
import { getDeliverable, listAgents, listDeliverables, runWorkflow, sendMessage, workflowsFor } from "./v1";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const SERVER_INFO = { name: "roster", title: "Roster AI employees", version: "1.0.0" };

const INSTRUCTIONS =
  "Roster connects you to the user's AI employees — agents with a job, memory, a knowledge base and their own inbox. " +
  "Use list_agents to see who is on the team and what workflows they run. Use ask_agent to give an agent a request or " +
  "question in plain language; it answers using its own knowledge of the business. Use list_deliverables / " +
  "get_deliverable to read finished work (reports, documents, tables, drafts). Use run_workflow to start one of an " +
  "agent's workflows now.";

// JSON-RPC error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type JsonRpcId = string | number;
type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId | null; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId | null; error: { code: number; message: string; data?: unknown } };

const rpcMessage = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().max(200), z.number().int()]).optional(),
  method: z.string().min(1).max(200),
  params: z.record(z.string(), z.unknown()).optional(),
});

type ToolDef = {
  name: string;
  title: string;
  description: string;
  scope: ApiScope;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean | string>;
  args: z.ZodType;
  run: (p: ApiPrincipal, args: never) => Promise<unknown>;
};

const uuid = { type: "string", format: "uuid" } as const;

const TOOLS: ToolDef[] = [
  {
    name: "list_agents",
    title: "List AI employees",
    description:
      "List the AI employees (agents) you can work with, including each one's role, inbox address and workflows " +
      "(with workflow ids you can pass to run_workflow). Call this first to find an agent_id.",
    scope: "agents:read",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        cursor: { type: "string", description: "next_cursor from a previous call" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    args: z.object({ limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(200).optional() }).strict(),
    run: async (p, a: { limit?: number; cursor?: string }) => {
      const pageRes = await listAgents(p, { limit: a.limit, cursor: a.cursor });
      const wfs = await workflowsFor(
        p,
        pageRes.data.map((x) => x.id),
      );
      return {
        agents: pageRes.data.map((x) => ({ ...x, workflows: wfs.get(x.id) ?? [] })),
        next_cursor: pageRes.nextCursor,
      };
    },
  },
  {
    name: "ask_agent",
    title: "Ask an AI employee",
    description:
      "Send a request or question to one AI employee and wait for its reply. Write it the way you would message a " +
      "colleague (e.g. \"Draft a quote for 500 branded tumblers for Acme\"). Pass conversation_id from a previous " +
      "reply to continue the same thread. Long-running work may come back as queued; its result then appears in " +
      "list_deliverables.",
    scope: "agents:invoke",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { ...uuid, description: "The agent's id from list_agents" },
        message: { type: "string", minLength: 1, maxLength: 20000, description: "What you want the agent to do or answer" },
        conversation_id: { ...uuid, description: "Optional: continue an existing conversation" },
      },
      required: ["agent_id", "message"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    args: z
      .object({ agent_id: z.uuid(), message: z.string().trim().min(1).max(20_000), conversation_id: z.uuid().optional() })
      .strict(),
    run: async (p, a: { agent_id: string; message: string; conversation_id?: string }) => {
      const res = await sendMessage(p, a.agent_id, { text: a.message, conversationId: a.conversation_id, wait: true }, "mcp");
      return {
        reply: res.body.reply,
        status: res.body.status,
        conversation_id: res.body.conversationId,
        run_id: res.body.runId,
      };
    },
  },
  {
    name: "list_deliverables",
    title: "List delivered work",
    description:
      "List finished work your AI employees delivered (reports, documents, tables, email drafts), newest first. " +
      "Filter by agent_id and/or since (ISO 8601). Returns titles and previews; use get_deliverable for the full body.",
    scope: "deliverables:read",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: uuid,
        since: { type: "string", format: "date-time", description: "Only work delivered at or after this time" },
        status: { type: "string", enum: ["new", "seen", "approved", "changes_requested", "archived"] },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        cursor: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    args: z
      .object({
        agent_id: z.uuid().optional(),
        since: z.iso.datetime({ offset: true }).optional(),
        status: z.enum(["new", "seen", "approved", "changes_requested", "archived"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().max(200).optional(),
      })
      .strict(),
    run: async (p, a: { agent_id?: string; since?: string; status?: string; limit?: number; cursor?: string }) => {
      const res = await listDeliverables(p, {
        agentId: a.agent_id,
        since: a.since,
        status: a.status,
        limit: a.limit ?? 20,
        cursor: a.cursor,
      });
      return {
        deliverables: res.data.map(({ body: _body, data: _data, ...rest }) => rest),
        next_cursor: res.nextCursor,
      };
    },
  },
  {
    name: "get_deliverable",
    title: "Read a deliverable",
    description: "Get one deliverable in full: its markdown body, structured data (e.g. table rows) and a portal link.",
    scope: "deliverables:read",
    inputSchema: {
      type: "object",
      properties: { deliverable_id: uuid },
      required: ["deliverable_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    args: z.object({ deliverable_id: z.uuid() }).strict(),
    run: async (p, a: { deliverable_id: string }) => getDeliverable(p, a.deliverable_id),
  },
  {
    name: "run_workflow",
    title: "Run a workflow now",
    description:
      "Start one of an agent's workflows immediately (workflow ids come from list_agents). The run is queued; its " +
      "result is delivered as a deliverable you can read with list_deliverables.",
    scope: "workflows:run",
    inputSchema: {
      type: "object",
      properties: { workflow_id: uuid },
      required: ["workflow_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    args: z.object({ workflow_id: z.uuid() }).strict(),
    run: async (p, a: { workflow_id: string }) => runWorkflow(p, a.workflow_id),
  },
];

function ok(id: JsonRpcId | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return data === undefined ? { jsonrpc: "2.0", id, error: { code, message } } : { jsonrpc: "2.0", id, error: { code, message, data } };
}

function negotiate(requested: unknown): string {
  return typeof requested === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

function toolResult(value: unknown, version: string) {
  const text = JSON.stringify(value, null, 2);
  const res: Record<string, unknown> = { content: [{ type: "text", text }], isError: false };
  // structuredContent exists from 2025-06-18; older clients just ignore unknown fields, but keep payloads lean.
  if (version >= "2025-06-18" && value && typeof value === "object" && !Array.isArray(value)) res.structuredContent = value;
  return res;
}

function toolError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function handleOne(msg: unknown, p: ApiPrincipal, version: string): Promise<JsonRpcResponse | null> {
  const parsed = rpcMessage.safeParse(msg);
  if (!parsed.success) {
    const id = (msg as { id?: unknown } | null)?.id;
    return rpcError(typeof id === "string" || typeof id === "number" ? id : null, INVALID_REQUEST, "Invalid JSON-RPC request");
  }
  const { id, method, params } = parsed.data;
  const isNotification = id === undefined;
  if (isNotification) {
    // notifications/initialized, notifications/cancelled, ... — nothing to do in a stateless server.
    return null;
  }

  switch (method) {
    case "initialize": {
      const v = negotiate(params?.protocolVersion);
      return ok(id, {
        protocolVersion: v,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list": {
      const tools = TOOLS.filter((t) => hasScope(p, t.scope)).map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: { title: t.title, ...t.annotations },
      }));
      return ok(id, { tools });
    }
    case "tools/call": {
      const name = params?.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (typeof name !== "string" || !tool) return rpcError(id, INVALID_PARAMS, `Unknown tool: ${String(name).slice(0, 80)}`);
      if (!hasScope(p, tool.scope)) {
        return ok(id, toolError(`This API key is missing the "${tool.scope}" scope required by ${tool.name}.`));
      }
      const rawArgs = params?.arguments ?? {};
      const args = tool.args.safeParse(rawArgs);
      if (!args.success) {
        const issue = args.error.issues[0];
        return ok(
          id,
          toolError(`Invalid arguments for ${tool.name}: ${issue ? `${issue.path.join(".") || "arguments"}: ${issue.message}` : "invalid"}`),
        );
      }
      try {
        const value = await tool.run(p, args.data as never);
        return ok(id, toolResult(value, version));
      } catch (err) {
        if (err instanceof ApiError && err.code !== "internal_error") return ok(id, toolError(err.message));
        logger.error({ err: err instanceof Error ? { name: err.name, message: err.message } : String(err), tool: tool.name }, "mcp: tool failed");
        return ok(id, toolError("The agent couldn't complete that right now. Try again in a moment."));
      }
    }
    case "resources/list":
      return ok(id, { resources: [] });
    case "prompts/list":
      return ok(id, { prompts: [] });
    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method.slice(0, 80)}`);
  }
}

function allowedOrigin(origin: string | null, appUrl: string): boolean {
  if (!origin) return true; // non-browser clients (Claude Desktop/Code, Codex) send no Origin
  const allow = new Set([new URL(appUrl).origin, ...(process.env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)]);
  return allow.has(origin);
}

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

/** POST /api/mcp */
export async function handleMcpPost(req: Request, appUrl: string): Promise<Response> {
  // DNS-rebinding / browser CSRF guard. Auth is bearer-only (no cookies) so this is defense in depth.
  if (!allowedOrigin(req.headers.get("origin"), appUrl)) {
    return Response.json(rpcError(null, INVALID_REQUEST, "Origin not allowed"), { status: 403, headers: JSON_HEADERS });
  }

  const headerVersion = req.headers.get("mcp-protocol-version");
  if (headerVersion && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(headerVersion)) {
    return Response.json(rpcError(null, INVALID_REQUEST, `Unsupported MCP-Protocol-Version: ${headerVersion.slice(0, 40)}`), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }

  let principal: ApiPrincipal;
  let rateHeaders: Record<string, string>;
  try {
    ({ principal, rateHeaders } = await authenticate(req));
  } catch (err) {
    if (err instanceof ApiError) {
      const status = err.code === "rate_limited" ? 429 : 401;
      const headers: Record<string, string> = { ...JSON_HEADERS, ...(err.headers ?? {}) };
      if (status === 401 && !bearerToken(req)) headers["WWW-Authenticate"] = 'Bearer realm="roster"';
      return Response.json(rpcError(null, status === 429 ? INTERNAL_ERROR : INVALID_REQUEST, err.message), { status, headers });
    }
    return errorResponse("internal_error", "Something went wrong.");
  }

  const raw = await readTextCapped(req, 512 * 1024);
  if (raw === null) {
    return Response.json(rpcError(null, INVALID_REQUEST, "Request too large"), { status: 413, headers: JSON_HEADERS });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json(rpcError(null, PARSE_ERROR, "Parse error"), { status: 400, headers: { ...JSON_HEADERS, ...rateHeaders } });
  }

  // Per spec, a request without the header (pre-initialize or old clients) is treated as 2025-03-26.
  const version = headerVersion ?? "2025-03-26";
  const headers = { ...JSON_HEADERS, ...rateHeaders };

  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > 20) {
      return Response.json(rpcError(null, INVALID_REQUEST, "Invalid batch"), { status: 400, headers });
    }
    const results: JsonRpcResponse[] = [];
    for (const m of body) {
      const r = await handleOne(m, principal, version);
      if (r) results.push(r);
    }
    if (!results.length) return new Response(null, { status: 202, headers: rateHeaders });
    return Response.json(results, { status: 200, headers });
  }

  // A JSON-RPC response or notification from the client: acknowledge.
  if (body && typeof body === "object" && !("method" in body) && ("result" in body || "error" in body)) {
    return new Response(null, { status: 202, headers: rateHeaders });
  }

  const result = await handleOne(body, principal, version);
  if (!result) return new Response(null, { status: 202, headers: rateHeaders });
  return Response.json(result, { status: 200, headers });
}

export const MCP_TOOL_NAMES = TOOLS.map((t) => t.name);
