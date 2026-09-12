import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server/index.mjs";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roster-webmcp-"));
const service = await createServer({
  directory,
  port: 0,
  runner: async () => ({ text: "Test response" }),
});
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.addInitScript(() => {
  const tools = [];
  Object.defineProperty(window, "__rosterTools", { value: tools });
  Object.defineProperty(document, "modelContext", {
    value: {
      registerTool(tool, { signal }) {
        tools.push(tool);
        signal.addEventListener("abort", () => {
          const index = tools.indexOf(tool);
          if (index >= 0) tools.splice(index, 1);
        });
      },
    },
  });
});
const page = await context.newPage();
try {
  await page.goto(service.url);
  await page.waitForFunction(() => window.__rosterTools?.length === 3);
  const metadata = await page.evaluate(() =>
    window.__rosterTools.map(({ name, annotations, inputSchema }) => ({
      name,
      annotations,
      inputSchema,
    })),
  );
  assert.deepEqual(
    metadata.map((tool) => tool.name),
    ["roster_read_workers", "roster_create_worker", "roster_open_conversation"],
  );
  assert.equal(metadata[0].annotations.readOnlyHint, true);
  assert.deepEqual(metadata[1].inputSchema.required, ["name", "role"]);

  const before = await page.evaluate(() =>
    window.__rosterTools
      .find((tool) => tool.name === "roster_read_workers")
      .execute({}),
  );
  assert.deepEqual(before, { workers: [] });
  await assert.rejects(
    page.evaluate(() =>
      window.__rosterTools
        .find((tool) => tool.name === "roster_create_worker")
        .execute({ name: "", role: "Engineer" }),
    ),
    /Provide a name and role/,
  );
  assert.equal(service.snapshot().agents.length, 0);

  const created = await page.evaluate(() =>
    window.__rosterTools
      .find((tool) => tool.name === "roster_create_worker")
      .execute({ name: "WebMCP Alex", role: "Engineer" }),
  );
  await page.getByRole("textbox", { name: "Message WebMCP Alex" }).waitFor();
  assert.equal(service.snapshot().agents.length, 1);
  await assert.rejects(
    page.evaluate(() =>
      window.__rosterTools
        .find((tool) => tool.name === "roster_open_conversation")
        .execute({ id: "missing" }),
    ),
    /Conversation not found/,
  );
  const opened = await page.evaluate(
    (id) =>
      window.__rosterTools
        .find((tool) => tool.name === "roster_open_conversation")
        .execute({ id }),
    created.conversationId,
  );
  assert.deepEqual(opened, { conversationId: created.conversationId });
  console.log("WebMCP contract checks passed.");
} finally {
  await browser.close();
  await service.close();
}
