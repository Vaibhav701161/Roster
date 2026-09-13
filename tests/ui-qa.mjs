import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { createServer } from "../server/index.mjs";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const directory = path.resolve("test-results", "ui-qa-" + Date.now());
fs.mkdirSync(directory, { recursive: true });
let mode = "approval",
  attempt = 0;
const service = await createServer({
  directory,
  port: 0,
  runner: async (options) => {
    if (mode === "approval") {
      assert.ok(options.prompt.includes("Attachment test content"));
      const allowed = await options.onApproval({
        title: "Save the acceptance-test result?",
        detail: "This is a test-only request to save a short result.",
      });
      assert.equal(allowed, true);
      options.onDelta("The attached context was reviewed.\n\n");
      options.onDelta("A concise result is ready.");
      return {
        text: "The attached context was reviewed.\n\nA concise result is ready.",
      };
    }
    if (mode === "cancel")
      return new Promise((resolve, reject) =>
        options.signal.addEventListener(
          "abort",
          () => reject(new Error("Cancelled")),
          { once: true },
        ),
      );
    if (mode === "failure" && !attempt++) {
      options.onDelta("Partial work preserved.");
      throw new Error("Test provider disconnected.");
    }
    options.onDelta("Retry succeeded.");
    return { text: "Retry succeeded." };
  },
});
const browser = await chromium.launch({ headless: true }),
  context = await browser.newContext({
    viewport: { width: 1440, height: 950 },
  }),
  page = await context.newPage(),
  errors = [],
  accessibility = [];
page.on("pageerror", (e) => errors.push(e.message));
const scan = async (name) => {
  const r = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  accessibility.push({
    name,
    violations: r.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      nodes: v.nodes.map((n) => ({ html: n.html, summary: n.failureSummary })),
    })),
  });
};
const waitFor = async (fn) => {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("UI state timed out");
};
try {
  await page.goto(service.url);
  await page.locator(".welcome h1").waitFor();
  await scan("welcome");
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(
      () => document.activeElement?.classList.contains("skip-link") || false,
    ),
    true,
  );
  await page.getByRole("button", { name: "Add your first worker" }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Close", exact: true })
      .evaluate((element) => document.activeElement === element),
    true,
  );
  await page
    .getByRole("button", { name: "Software Engineer", exact: true })
    .click();
  await scan("worker-dialog");
  await page
    .getByRole("button", { name: "Add to roster", exact: true })
    .last()
    .click();
  await page.getByRole("textbox", { name: "Message Alex" }).waitFor();
  await page.locator("input[type=file]").setInputFiles({
    name: "context.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("Attachment test content"),
  });
  await page
    .getByRole("textbox", { name: "Message Alex" })
    .fill("Review the attached context and write a concise result.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
  await scan("approval");
  await page.screenshot({
    path: path.join(directory, "approval.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByText("A concise result is ready.", { exact: true }).waitFor();
  await page.locator(".task-chat-card").click();
  await page.getByRole("button", { name: "Record your verification" }).click();
  await page
    .getByLabel("What did you check?")
    .fill("Read the actual result and checked its content.");
  await page
    .getByRole("button", { name: "Save verification", exact: true })
    .click();
  await page
    .locator(".detail-pair")
    .filter({ hasText: "Verification" })
    .getByText("Verified", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Close work details" }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByText("context.md", { exact: true }).waitFor();
  assert.equal(await page.locator(".file-row").count(), 2);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .locator(".file-row")
      .filter({ hasText: "Work result" })
      .getByRole("link", { name: "Download" })
      .click(),
  ]);
  const file = await download.path();
  assert.ok(fs.readFileSync(file, "utf8").includes("A concise result"));
  await scan("files");
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  mode = "cancel";
  await page
    .getByRole("textbox", { name: "Message Alex" })
    .fill("Inspect a task that will be cancelled.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("button", { name: "Stop current work" }).click();
  await waitFor(() =>
    service.snapshot().tasks.some((t) => t.status === "cancelled"),
  );
  mode = "failure";
  await waitFor(() => service.engine.active.size === 0);
  await page
    .getByRole("textbox", { name: "Message Alex" })
    .fill("Inspect provider failure recovery.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page
    .locator(".bubble")
    .getByText("Partial work preserved.", { exact: true })
    .waitFor();
  await page
    .locator(".task-chat-card")
    .filter({ hasText: "Couldn’t finish" })
    .click();
  await page
    .getByRole("button", { name: "Retry with recovery plan", exact: true })
    .click();
  await waitFor(() =>
    service.store.one("SELECT * FROM tasks WHERE result='Retry succeeded.'"),
  );
  await page.getByRole("button", { name: "Close work details" }).click();
  await page.getByRole("button", { name: "Chat options" }).click();
  await page.getByRole("button", { name: "Pin chat", exact: true }).click();
  assert.equal(service.snapshot().conversations[0].pinned, 1);
  await page.getByRole("button", { name: "Chat options" }).click();
  await page.getByRole("button", { name: "Archive chat", exact: true }).click();
  await page.getByRole("button", { name: "Archived chats" }).click();
  await page.locator(".conversation-row").waitFor();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await scan("light-settings");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await scan("dark-settings");
  await page.screenshot({
    path: path.join(directory, "dark.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await scan("mobile-settings");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(directory, "accessibility.json"),
    JSON.stringify(accessibility, null, 2),
  );
  fs.writeFileSync(
    path.join(directory, "results.json"),
    JSON.stringify(
      {
        passed: true,
        checks: [
          "text attachment",
          "approval in chat",
          "verification with evidence",
          "artifact download",
          "cancellation",
          "failure and retry",
          "pin and archive",
          "responsive settings",
        ],
        accessibilityViolations: accessibility.reduce(
          (n, r) => n + r.violations.length,
          0,
        ),
      },
      null,
      2,
    ),
  );
  console.log("UI flow checks passed:", directory);
  console.log(
    "Accessibility findings:",
    accessibility.map((r) => ({
      name: r.name,
      rules: r.violations.map((v) => v.id),
    })),
  );
} catch (error) {
  console.error(error);
  await page.screenshot({
    path: path.join(directory, "failure.png"),
    fullPage: true,
  });
  fs.writeFileSync(path.join(directory, "failure.txt"), String(error.stack));
  fs.writeFileSync(
    path.join(directory, "accessibility.json"),
    JSON.stringify(accessibility, null, 2),
  );
  process.exitCode = 1;
} finally {
  await browser.close();
  await service.close();
}
