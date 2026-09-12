import { chromium } from "playwright";
import { createServer } from "../server/index.mjs";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const directory = path.resolve("test-results", "web-e2e-" + Date.now());
fs.mkdirSync(directory, { recursive: true });
const service = await createServer({ directory, port: 0 });
const browser = await chromium.launch({
  channel: process.env.ROSTER_TEST_BROWSER || "msedge",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } }),
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const log = (message) => console.log(new Date().toISOString(), message);
const waitFor = async (predicate, timeout = 120000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Timed out waiting for runtime state");
};
let closed = false;
try {
  await page.goto(service.url);
  await page
    .getByRole("heading", { name: "Good work starts with a conversation." })
    .waitFor();
  await page.screenshot({
    path: path.join(directory, "01-welcome.png"),
    fullPage: true,
  });
  log("Welcome rendered");
  await page.getByRole("button", { name: "Add your first worker" }).click();
  await page
    .getByRole("button", { name: "Software Engineer", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add to roster", exact: true })
    .last()
    .click();
  await page.getByRole("textbox", { name: "Message Alex" }).waitFor();
  log("Created Alex in browser");
  await page
    .getByRole("textbox", { name: "Message Alex" })
    .fill(
      "Hi Alex. In one sentence, tell me your name and role. Do not use tools.",
    );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await waitFor(() =>
    service.store.one(
      "SELECT * FROM tasks WHERE status IN ('completed','failed')",
    ),
  );
  let task = service.store.one("SELECT * FROM tasks ORDER BY created_at DESC");
  assert.equal(task.status, "completed", task.error);
  await page.locator(".incoming .bubble").filter({ hasText: "Alex" }).waitFor();
  await page.screenshot({
    path: path.join(directory, "02-real-chat.png"),
    fullPage: true,
  });
  log("Real Codex reply rendered");
  await page.locator("button.contact-header").click();
  await page
    .getByRole("textbox", { name: "Memory", exact: true })
    .fill("I prefer concise, practical answers.");
  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  await page
    .getByText("I prefer concise, practical answers.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Close details" }).click();
  await page.getByRole("button", { name: "Roster", exact: true }).click();
  await page.getByRole("button", { name: "Edit Alex", exact: true }).click();
  await page
    .getByLabel("What should they be great at?")
    .fill("Builds software and explains changes clearly.");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByRole("button", { name: "Bench Alex", exact: true }).click();
  await page
    .getByRole("button", { name: "Unbench Alex", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Unbench Alex", exact: true }).click();
  log("Worker editing, bench and memory verified");
  await page.getByRole("button", { name: "Add worker", exact: true }).click();
  await page
    .getByRole("button", { name: "QA / Reviewer", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add to roster", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Message Sam" }).waitFor();
  await page
    .getByRole("button", { name: "Teams", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "New team", exact: true }).click();
  await page.getByLabel("Team name").fill("Product team");
  await page
    .getByLabel("What are you working toward?")
    .fill("Build and verify reliable software.");
  await page
    .locator(".member-option")
    .filter({ hasText: "Alex" })
    .getByRole("checkbox")
    .check();
  await page
    .locator(".member-option")
    .filter({ hasText: "Sam" })
    .getByRole("checkbox")
    .check();
  await page.getByRole("button", { name: "Create team", exact: true }).click();
  await page.getByRole("textbox", { name: "Message Product team" }).waitFor();
  log("Created team in browser");
  await page
    .getByRole("textbox", { name: "Message Product team" })
    .fill(
      "@Alex write a three-item checklist for testing a login form. Then hand that checklist to @Sam to review for missing edge cases. Keep both answers short. Do not use tools.",
    );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const team = service.snapshot().teams[0],
    conv = service.snapshot().conversations.find((c) => c.team_id === team.id);
  await waitFor(() => {
    const tasks = service.store.all(
      "SELECT * FROM tasks WHERE conversation_id=?",
      [conv.id],
    );
    const errs = service.store.all(
      "SELECT * FROM messages WHERE conversation_id=? AND kind='error'",
      [conv.id],
    );
    if (errs.length) throw new Error(errs[0].content);
    return (
      tasks.length >= 2 &&
      tasks.every((t) => ["completed", "failed"].includes(t.status))
    );
  }, 240000);
  const teamTasks = service.store.all(
    "SELECT * FROM tasks WHERE conversation_id=? ORDER BY created_at",
    [conv.id],
  );
  assert.ok(
    teamTasks.every((t) => t.status === "completed"),
    JSON.stringify(teamTasks),
  );
  assert.ok(service.store.all("SELECT * FROM task_dependencies").length >= 1);
  await page.screenshot({
    path: path.join(directory, "03-team-handoff.png"),
    fullPage: true,
  });
  log("Real multi-worker handoff completed");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await page.screenshot({
    path: path.join(directory, "04-dark-settings.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  await page.keyboard.press("Control+k");
  await page
    .getByRole("textbox", { name: "Search your workspace" })
    .fill("checklist");
  await page.locator(".search-results button").first().waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(directory, "05-mobile-chat.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
    "Mobile layout overflow",
  );
  await page.getByRole("button", { name: "Back to chats" }).click();
  await page.getByRole("heading", { name: "Chats", exact: true }).waitFor();
  await page.screenshot({
    path: path.join(directory, "06-mobile-list.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  log("Theme, search and mobile navigation verified");
  await browser.close();
  closed = true;
  await service.close();
  const reopened = await createServer({ directory, port: 0 });
  const persisted = reopened.snapshot();
  assert.equal(persisted.agents.length, 2);
  assert.equal(persisted.teams.length, 1);
  assert.equal(persisted.memories.length, 1);
  assert.ok(
    persisted.tasks.filter((t) => t.status === "completed").length >= 3,
  );
  await reopened.close();
  fs.writeFileSync(
    path.join(directory, "results.json"),
    JSON.stringify(
      {
        passed: true,
        checks: [
          "real direct chat",
          "worker create/edit/bench",
          "memory",
          "team create",
          "real handoff and dependency",
          "light/dark",
          "search",
          "mobile navigation",
          "restart persistence",
        ],
        screenshots: 6,
      },
      null,
      2,
    ),
  );
  log("PASS. Artifacts: " + directory);
} catch (error) {
  await page
    .screenshot({ path: path.join(directory, "failure.png"), fullPage: true })
    .catch(() => {});
  console.error(error);
  fs.writeFileSync(path.join(directory, "failure.txt"), String(error.stack));
  process.exitCode = 1;
} finally {
  if (!closed) await browser.close();
  if (service.server.listening) await service.close();
}
