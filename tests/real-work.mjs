import { createServer } from "../server/index.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const directory = path.resolve("test-results", "real-work-" + Date.now()),
  workspace = path.join(directory, "sample-project");
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(
  path.join(workspace, "calculator.mjs"),
  "export function add(a, b) { return a - b; }\n",
);
fs.writeFileSync(
  path.join(workspace, "test.mjs"),
  "import assert from 'node:assert/strict'; import {add} from './calculator.mjs'; assert.equal(add(2,3),5); assert.equal(add(-2,3),1); console.log('2 calculator checks passed');\n",
);
fs.writeFileSync(path.join(workspace, ".gitignore"), ".roster/\n");
for (const args of [
  ["init", "--initial-branch=main"],
  ["config", "user.email", "roster-test@example.invalid"],
  ["config", "user.name", "Roster acceptance test"],
  ["add", "."],
  ["commit", "-m", "Create calculator fixture"],
])
  execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
const service = await createServer({
  directory: path.join(directory, "data"),
  port: 0,
});
const request = async (route, method = "GET", data) => {
  const r = await fetch(service.url + "/api" + route, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error);
  return body;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
console.log("Testing real work in", workspace);
try {
  await service.engine.detect();
  const alex = await request("/agents", "POST", {
    name: "Alex",
    role: "Software Engineer",
    workspace,
    instructions:
      "Use apply_patch for the minimal fix. Request approval through the runtime if needed. Only modify calculator.mjs.",
  });
  const sam = await request("/agents", "POST", {
    name: "Sam",
    role: "QA Reviewer",
    workspace,
    instructions:
      "Independently run node test.mjs. Report the actual test result. Do not modify files.",
  });
  const team = await request("/teams", "POST", {
    name: "Calculator QA",
    objective: "Fix and independently verify the provided calculator fixture.",
    workspace,
    members: [alex.id, sam.id],
  });
  await request(`/conversations/${team.conversationId}/messages`, "POST", {
    content:
      "@Alex inspect calculator.mjs and test.mjs, fix the add function to add instead of subtract, then hand it to @Sam to independently run node test.mjs and verify the fix. Work only in the provided sample project. Keep messages concise.",
  });
  const deadline = Date.now() + 300000;
  let complete = false,
    approvals = 0;
  while (Date.now() < deadline) {
    const state = await request("/state");
    for (const approval of state.approvals.filter(
      (a) => a.status === "pending",
    )) {
      const detail = JSON.parse(approval.detail);
      const taskWorkspaces = [
        workspace,
        ...state.tasks.map((task) => task.worktree_path).filter(Boolean),
      ];
      const isInside = (p) => {
        const absolute = path.resolve(p);
        return taskWorkspaces.some((root) => {
          const relative = path.relative(root, absolute);
          return !relative.startsWith("..") && !path.isAbsolute(relative);
        });
      };
      const safeCwd = taskWorkspaces.some(
        (root) => path.resolve(detail.cwd).toLowerCase() === root.toLowerCase(),
      );
      const safeChanges =
        !detail.changes ||
        detail.changes.every(
          (change) =>
            isInside(change.path) &&
            path.basename(change.path) === "calculator.mjs",
        );
      const safeCommand =
        !detail.command ||
        (!/Remove-Item|\brm\b|\bdel\b|Invoke-WebRequest|\bcurl\b|https?:|Start-Process|Set-ExecutionPolicy/i.test(
          detail.command,
        ) &&
          /node|Get-Content|Get-ChildItem|apply_patch|calculator\.mjs|test\.mjs/i.test(
            detail.command,
          ));
      if (!safeCwd || !safeChanges || !safeCommand)
        throw new Error(
          "Test declined an approval outside the harmless fixture: " +
            approval.detail,
        );
      console.log("Approving fixture action:", approval.title);
      await request(`/approvals/${approval.id}`, "POST", { allow: true });
      approvals++;
    }
    const messages = service.store.all(
      "SELECT * FROM messages WHERE conversation_id=? AND kind='error'",
      [team.conversationId],
    );
    if (messages.length) throw new Error(messages[0].content);
    const tasks = state.tasks.filter(
      (t) => t.conversation_id === team.conversationId,
    );
    if (
      tasks.length >= 2 &&
      tasks.every((t) =>
        ["completed", "failed", "cancelled"].includes(t.status),
      )
    ) {
      assert.ok(
        tasks.every((t) => t.status === "completed"),
        JSON.stringify(tasks),
      );
      complete = true;
      break;
    }
    await wait(500);
  }
  assert.ok(complete, "Real work reached the test deadline");
  const tasks = service.snapshot().tasks;
  const main = tasks.find((t) => t.owner_id === alex.id);
  assert.ok(main?.worktree_path, "Work task received an isolated checkout");
  const reviewTask = tasks.find((t) => t.kind === "review");
  assert.equal(
    service.store.one("SELECT verdict FROM review_verdicts WHERE task_id=?", [
      reviewTask.id,
    ]).verdict,
    "pass",
    "The reviewer returned a structured passing verdict.",
  );
  assert.equal(main.verification, "verified");
  assert.ok(main.has_receipt, "The verified task has a durable work receipt.");
  assert.equal(
    main.criteria_passed,
    main.criteria_total,
    "A review-backed default outcome records all of its completion criteria.",
  );
  const checks = execFileSync(process.execPath, ["test.mjs"], {
    cwd: main.worktree_path,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.match(
    fs.readFileSync(path.join(workspace, "calculator.mjs"), "utf8"),
    /return a - b/,
    "The user's checkout remains unchanged until they explicitly integrate it.",
  );
  assert.match(
    execFileSync("git", ["diff", "--", "calculator.mjs"], {
      cwd: main.worktree_path,
      encoding: "utf8",
    }),
    /return a \+ b/,
    "The candidate patch contains the requested repair.",
  );
  assert.ok(
    service.store.all("SELECT * FROM events WHERE type='action.completed'")
      .length > 0,
  );
  await request(`/tasks/${main.id}/verify`, "POST", {
    evidence:
      checks.trim() +
      "; independently executed by the acceptance test after the worker finished.",
  });
  fs.writeFileSync(
    path.join(directory, "results.json"),
    JSON.stringify(
      {
        passed: true,
        approvals,
        checks: checks.trim(),
        tasks: service.snapshot().tasks,
        events: service.store.all("SELECT * FROM events ORDER BY created_at"),
      },
      null,
      2,
    ),
  );
  console.log("PASS: isolated candidate changed, was reviewed, and verified.", {
    approvals,
    checks: checks.trim(),
  });
} catch (error) {
  fs.writeFileSync(
    path.join(directory, "failure.json"),
    JSON.stringify(
      {
        error: String(error.stack),
        state: service.snapshot(),
        events: service.store.all("SELECT * FROM events"),
      },
      null,
      2,
    ),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  await service.close();
}
