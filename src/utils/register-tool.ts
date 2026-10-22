import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Creates new objects or appends data; never overwrites or removes anything. */
const ADDITIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Overwrites fields on an existing object; repeating the call with the same args is a no-op. */
const OVERWRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/** Removes / archives an object or its data. Repeat calls have no further effect. */
const REMOVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/** Unknown effect (e.g. raw_graph_post): assume the worst. */
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * Derive MCP behaviour hints for a mutating tool from its name, so every
 * write tool gets accurate annotations without per-call boilerplate.
 * Exported for tests.
 */
export function writeAnnotationsFor(name: string): ToolAnnotations {
  if (/^(delete|archive|remove)_/.test(name) || name === "raw_graph_delete")
    return REMOVE;
  if (/^(update|pause|resume)_/.test(name) || name === "bulk_upsert_products")
    return OVERWRITE;
  if (/^(create|duplicate|upload|add|send)_/.test(name)) return ADDITIVE;
  return WRITE;
}

export function readTool<Args extends ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: Args,
  handler: ToolCallback<Args>,
) {
  return server.registerTool(
    name,
    { description, inputSchema, annotations: READ_ONLY },
    handler,
  );
}

export function writeTool<Args extends ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: Args,
  handler: ToolCallback<Args>,
) {
  return server.registerTool(
    name,
    { description, inputSchema, annotations: writeAnnotationsFor(name) },
    handler,
  );
}
