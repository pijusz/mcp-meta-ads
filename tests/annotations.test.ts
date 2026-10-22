import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "@/server";

async function listTools() {
  const server = createServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  const { tools } = await client.listTools();
  await client.close();
  return new Map(tools.map((t) => [t.name, t.annotations ?? {}]));
}

describe("tool annotations", () => {
  test("every tool declares all four hints", async () => {
    const tools = await listTools();
    expect(tools.size).toBeGreaterThan(50);
    for (const [name, a] of tools) {
      for (const hint of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ]) {
        expect({
          name,
          hint,
          value: typeof (a as Record<string, unknown>)[hint],
        }).toEqual({
          name,
          hint,
          value: "boolean",
        });
      }
    }
  });

  test("delete/archive/remove tools are destructive", async () => {
    const tools = await listTools();
    const removers = [...tools.keys()].filter((n) =>
      /^(delete|archive|remove)_|^raw_graph_delete$/.test(n),
    );
    expect(removers.length).toBeGreaterThanOrEqual(12);
    for (const n of removers) {
      expect({ n, ...tools.get(n) }).toMatchObject({
        n,
        readOnlyHint: false,
        destructiveHint: true,
      });
    }
  });

  test("creates are additive, reads are read-only, raw POST assumes the worst", async () => {
    const tools = await listTools();
    expect(tools.get("create_campaign")).toMatchObject({
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(tools.get("pause_campaign")).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
    });
    expect(tools.get("run_insights")).toMatchObject({ readOnlyHint: true });
    expect(tools.get("raw_graph_get")).toMatchObject({ readOnlyHint: true });
    expect(tools.get("raw_graph_post")).toMatchObject({
      destructiveHint: true,
      idempotentHint: false,
    });
  });
});
