import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json";
import { registerAllResources } from "./resources/index.js";
import { registerAllTools } from "./tools/index.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "mcp-meta-ads",
    version: pkg.version,
  });

  registerAllResources(server);
  registerAllTools(server);

  return server;
}
