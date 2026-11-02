/** OpenAPI 3.1 description of the public API v1. */
import { API_SCOPES, SCOPE_LABELS } from "./keys";

const err = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

const commonErrors = {
  "401": err("Missing, invalid, revoked or expired API key"),
  "403": err("The key lacks the required scope"),
  "429": err("Rate limit exceeded (see Retry-After)"),
};

const idParam = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const pageParams = [
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
  { name: "cursor", in: "query", schema: { type: "string" }, description: "Opaque `nextCursor` from the previous page" },
];

export function openApiDocument(appUrl: string) {
  const base = appUrl.replace(/\/+$/, "");
  return {
    openapi: "3.1.0",
    info: {
      title: "Roster API",
      version: "1.0.0",
      description:
        "Work with your AI employees programmatically. Authenticate with an API key (`Authorization: Bearer rk_live_…`) " +
        "created in Settings → API & MCP. A key only ever sees its own organization, and optionally a single agent. " +
        "Errors are always `{ \"error\": { \"code\", \"message\" } }`. Lists use cursor pagination " +
        "(`{ data, nextCursor, hasMore }`). Each key is limited to 120 requests per minute.",
    },
    servers: [{ url: `${base}/api/v1` }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: {
        bearer: {
          type: "http",
          scheme: "bearer",
          description: `Scopes: ${API_SCOPES.map((s) => `\`${s}\` (${SCOPE_LABELS[s]})`).join(", ")}`,
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: {
                  type: "string",
                  enum: ["unauthorized", "insufficient_scope", "not_found", "invalid_request", "rate_limited", "conflict", "internal_error"],
                },
                message: { type: "string" },
                details: {},
              },
            },
          },
        },
        Agent: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            role: { type: "string" },
            summary: { type: ["string", "null"] },
            status: { type: "string", enum: ["provisioning", "active", "paused"] },
            email: { type: ["string", "null"], description: "The agent's own inbox" },
            phone: { type: ["string", "null"] },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        Workflow: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            trigger: { type: "string", enum: ["schedule", "event", "manual"] },
            outputKind: { type: "string" },
            enabled: { type: "boolean" },
            nextRunAt: { type: ["string", "null"], format: "date-time" },
            lastRunAt: { type: ["string", "null"], format: "date-time" },
          },
        },
        Deliverable: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            agentId: { type: "string", format: "uuid" },
            workflowId: { type: ["string", "null"], format: "uuid" },
            title: { type: "string" },
            kind: { type: "string", description: "report | document | table | email_draft | message" },
            preview: { type: ["string", "null"] },
            body: { type: "string", description: "Markdown (GFM)" },
            data: { type: ["object", "null"] },
            status: { type: "string", enum: ["new", "seen", "approved", "changes_requested", "archived"] },
            needsReview: { type: "boolean" },
            deliveredVia: { type: "array", items: { type: "string" } },
            hoursSaved: { type: "number" },
            createdAt: { type: "string", format: "date-time" },
            portalUrl: { type: "string", format: "uri" },
          },
        },
        MessageResult: {
          type: "object",
          properties: {
            conversationId: { type: "string", format: "uuid" },
            runId: { type: "string", format: "uuid" },
            reply: { type: ["string", "null"] },
            status: { type: "string", enum: ["completed", "queued"] },
          },
        },
      },
    },
    paths: {
      "/agents": {
        get: {
          operationId: "listAgents",
          summary: "List agents",
          description: "Scope: `agents:read`.",
          parameters: pageParams,
          responses: {
            "200": {
              description: "A page of agents",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: { type: "array", items: { $ref: "#/components/schemas/Agent" } },
                      nextCursor: { type: ["string", "null"] },
                      hasMore: { type: "boolean" },
                    },
                  },
                },
              },
            },
            ...commonErrors,
          },
        },
      },
      "/agents/{id}": {
        get: {
          operationId: "getAgent",
          summary: "Get an agent and its workflows",
          description: "Scope: `agents:read`.",
          parameters: [idParam],
          responses: {
            "200": {
              description: "The agent",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: {
                        allOf: [
                          { $ref: "#/components/schemas/Agent" },
                          { type: "object", properties: { workflows: { type: "array", items: { $ref: "#/components/schemas/Workflow" } } } },
                        ],
                      },
                    },
                  },
                },
              },
            },
            "404": err("Not found (or not visible to this key)"),
            ...commonErrors,
          },
        },
      },
      "/agents/{id}/messages": {
        post: {
          operationId: "messageAgent",
          summary: "Send a message or request to an agent",
          description:
            "Scope: `agents:invoke`. With `wait: true` the agent works inline (bounded) and the reply is returned (200). " +
            "Otherwise the request is queued (202) and the work shows up in the conversation and as deliverables.",
          parameters: [idParam],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["text"],
                  properties: {
                    text: { type: "string", minLength: 1, maxLength: 20000 },
                    conversationId: { type: "string", format: "uuid", description: "Continue an existing conversation" },
                    wait: { type: "boolean", default: false },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Completed", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/MessageResult" } } } } } },
            "202": { description: "Queued", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/MessageResult" } } } } } },
            "400": err("Invalid body"),
            "404": err("Agent or conversation not found"),
            "409": err("Agent is paused"),
            ...commonErrors,
          },
        },
      },
      "/deliverables": {
        get: {
          operationId: "listDeliverables",
          summary: "List delivered work",
          description: "Scope: `deliverables:read`. Newest first.",
          parameters: [
            ...pageParams,
            { name: "agentId", in: "query", schema: { type: "string", format: "uuid" } },
            { name: "since", in: "query", schema: { type: "string", format: "date-time" } },
            { name: "status", in: "query", schema: { type: "string", enum: ["new", "seen", "approved", "changes_requested", "archived"] } },
          ],
          responses: {
            "200": {
              description: "A page of deliverables",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: { type: "array", items: { $ref: "#/components/schemas/Deliverable" } },
                      nextCursor: { type: ["string", "null"] },
                      hasMore: { type: "boolean" },
                    },
                  },
                },
              },
            },
            "400": err("Invalid filter or cursor"),
            ...commonErrors,
          },
        },
      },
      "/deliverables/{id}": {
        get: {
          operationId: "getDeliverable",
          summary: "Get a deliverable",
          description: "Scope: `deliverables:read`.",
          parameters: [idParam],
          responses: {
            "200": { description: "The deliverable", content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/Deliverable" } } } } } },
            "404": err("Not found"),
            ...commonErrors,
          },
        },
      },
      "/workflows/{id}/run": {
        post: {
          operationId: "runWorkflow",
          summary: "Run a workflow now",
          description: "Scope: `workflows:run`. Queues a run; the result arrives as a deliverable.",
          parameters: [idParam],
          responses: {
            "202": {
              description: "Queued",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: {
                        type: "object",
                        properties: { runId: { type: "string", format: "uuid" }, workflowId: { type: "string", format: "uuid" }, status: { const: "queued" } },
                      },
                    },
                  },
                },
              },
            },
            "404": err("Not found"),
            "409": err("Agent paused or workflow disabled"),
            ...commonErrors,
          },
        },
      },
    },
  };
}
