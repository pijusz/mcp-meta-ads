import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllResources } from "@/resources/index";
import { registerAllTools } from "@/tools/index";
import pkg from "../package.json";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "mcp-meta-ads",
    version: pkg.version,
  });

  registerAllResources(server);
  registerAllTools(server);

  return server;
}
