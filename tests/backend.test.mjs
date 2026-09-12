import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createServer } from "../server/index.mjs";
import { validatePlan } from "../server/engine.mjs";
import { createVault } from "../server/vault.mjs";

async function fixture(runner) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roster-test-"));
  const app = await createServer({ directory, port: 0, runner });
  const request = async (route, method = "GET", body) => {
    const response = await fetch(app.url + "/api" + route, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  };
  return { app, request, directory };
}
async function until(fn, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const r = await fn();
    if (r) return r;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Condition timed out");
}
const worker = (name, extra = {}) => ({
  name,
  role: "Software Engineer",
  description: "A test worker.",
  ...extra,
});

test("worker, team, attachment, memory and conversation persist across restart", async () => {
  const f = await fixture(async (o) => {
    o.onDelta?.("Actual test-adapter response");
    return { text: "Actual test-adapter response" };
  });
  try {
    const a = await f.request("/agents", "POST", worker("Alex"));
    const b = await f.request("/agents", "POST", worker("Sam"));
    const t = await f.request("/teams", "POST", {
      name: "Test team",
      objective: "Verify persistence",
      members: [a.id, b.id],
    });
    await f.request(`/conversations/${a.conversationId}/messages`, "POST", {
      content: "Hello",
      attachments: [{ name: "context.md", content: "Attachment evidence" }],
    });
    await until(() =>
      f.app.store.one("SELECT * FROM tasks WHERE status='completed'"),
    );
    await f.request("/memories", "POST", {
      scopeId: a.id,
      content: "Prefer concise responses",
    });
    await f.request(
      `/agents/${a.id}`,
      "PUT",
      worker("Alex", { benched: true }),
    );
    let state = await f.request("/state");
    assert.equal(state.agents.find((x) => x.id === a.id).status, "benched");
    await f.request(
      `/agents/${a.id}`,
      "PUT",
      worker("Alex", { benched: false }),
    );
    await f.request(`/teams/${t.id}`, "PUT", {
      name: "Updated team",
      objective: "Keep history",
      members: [a.id],
    });
    await f.app.close();
    const restarted = await createServer({
      directory: f.directory,
      port: 0,
      runner: async () => ({ text: "unused" }),
    });
    state = restarted.snapshot();
    assert.equal(state.agents.length, 2);
    assert.equal(state.teams[0].members.length, 1);
    assert.equal(state.memories[0].content, "Prefer concise responses");
    assert.equal(state.tasks[0].status, "completed");
    assert.equal(
      restarted.store.all("SELECT * FROM attachments")[0].content,
      "Attachment evidence",
    );
    assert.equal(restarted.store.all("SELECT * FROM messages").length, 2);
    await restarted.close();
  } finally {
    if (f.app.server.listening) await f.app.close();
  }
});

test("worker avatars stay local and accept only bounded image data", async () => {
  const f = await fixture(async () => ({ text: "unused" }));
  try {
    const avatar = "data:image/png;base64,aGVsbG8=";
    const created = await f.request(
      "/agents",
      "POST",
      worker("Alex", { avatar_data: avatar }),
    );
    assert.equal(
      f.app.store.one("SELECT avatar_data FROM agents WHERE id=?", [created.id])
        .avatar_data,
      avatar,
    );
    await assert.rejects(
      () =>
        f.request(
          "/agents",
          "POST",
          worker("Bad image", {
            avatar_data: "data:text/plain;base64,aGVsbG8=",
          }),
        ),
      /Use a PNG, JPEG, or WebP avatar/,
    );
  } finally {
    await f.app.close();
  }
});

test("chat background preference persists locally", async () => {
  const f = await fixture(async () => ({ text: "unused" }));
  try {
    await f.request("/settings", "POST", { wallpaper: "paper" });
    assert.equal((await f.request("/state")).settings.wallpaper, "paper");
  } finally {
    await f.app.close();
  }
});

test("team routing, dependency outputs, approval pause/resume, explicit mentions and bench exclusion", async () => {
  let members = [],
    calls = [],
    approval = false;
  const f = await fixture(async (o) => {
    if (o.outputSchema?.properties?.verdict) {
      const verdict = JSON.stringify({
        verdict: "pass",
        summary: "The plan is complete and review checks passed.",
        issues: [],
        checks: [
          {
            name: "Plan review",
            status: "pass",
            evidence: "Reviewed dependency output.",
          },
        ],
      });
      return {
        text: `${JSON.stringify({
          verdict: "unable_to_verify",
          summary: "Checking the dependency before issuing the final verdict.",
          issues: [],
          checks: [],
        })}\n\n${verdict}`,
      };
    }
    if (o.outputSchema) {
      assert.ok(!o.prompt.includes("Bench Worker"));
      return {
        text: JSON.stringify({
          type: "task",
          assignments: [
            {
              agent_id: members[0],
              objective: "Write a plan",
              depends_on: [],
              kind: "work",
            },
            {
              agent_id: members[1],
              objective: "Review the plan",
              depends_on: [0],
              kind: "review",
            },
          ],
        }),
      };
    }
    calls.push(o.prompt);
    if (calls.length === 1) {
      approval = await o.onApproval({
        title: "Write test artifact?",
        detail: "Create a harmless test artifact",
      });
      assert.equal(approval, true);
      o.onDelta("Plan complete");
      return { text: "Plan complete" };
    }
    if (calls.length === 2) assert.ok(o.prompt.includes("Plan complete"));
    o.onDelta("Review complete");
    return { text: "Review complete" };
  });
  try {
    const a = await f.request("/agents", "POST", worker("Alex")),
      b = await f.request("/agents", "POST", worker("Sam")),
      c = await f.request(
        "/agents",
        "POST",
        worker("Bench Worker", { benched: true }),
      );
    members = [a.id, b.id];
    const team = await f.request("/teams", "POST", {
      name: "Engineering",
      members: [a.id, b.id, c.id],
    });
    await f.request(`/conversations/${team.conversationId}/messages`, "POST", {
      content: "Make a plan and review it.",
    });
    const pending = await until(() =>
      f.app.store.one("SELECT * FROM approvals WHERE status='pending'"),
    );
    assert.equal(calls.length, 1);
    assert.equal(
      f.app.store.one("SELECT status FROM tasks WHERE id=?", [pending.task_id])
        .status,
      "waiting_approval",
    );
    await f.request(`/approvals/${pending.id}`, "POST", { allow: true });
    await until(
      () =>
        f.app.store.all("SELECT * FROM tasks WHERE status='completed'")
          .length === 2,
    );
    assert.equal(calls.length, 1);
    assert.equal(
      f.app.store.one("SELECT verification FROM tasks WHERE id=?", [
        pending.task_id,
      ]).verification,
      "verified",
    );
    await f.request(`/conversations/${team.conversationId}/messages`, "POST", {
      content: "@Alex inspect the plan.",
    });
    await until(
      () =>
        f.app.store.all("SELECT * FROM tasks WHERE status='completed'")
          .length === 3,
    );
    assert.equal(
      f.app.store.all("SELECT owner_id FROM tasks ORDER BY rowid DESC")[0]
        .owner_id,
      a.id,
    );
    assert.equal(
      f.app.store.all("SELECT * FROM tasks WHERE owner_id=?", [c.id]).length,
      0,
    );
  } finally {
    await f.app.close();
  }
});

test("cancel terminates work, expires approvals, and cancels downstream tasks", async () => {
  const f = await fixture(async (o) => {
    await o.onApproval({ title: "Pending action", detail: "Test-only action" });
    if (o.signal.aborted) throw new Error("Cancelled");
    return { text: "Should not succeed" };
  });
  try {
    const a = await f.request("/agents", "POST", worker("Alex"));
    await f.request(`/conversations/${a.conversationId}/messages`, "POST", {
      content: "Build a test",
    });
    const approval = await until(() =>
      f.app.store.one("SELECT * FROM approvals WHERE status='pending'"),
    );
    await f.request(`/tasks/${approval.task_id}/cancel`, "POST", {});
    await until(() => f.app.engine.active.size === 0);
    assert.equal(
      f.app.store.one("SELECT status FROM tasks WHERE id=?", [approval.task_id])
        .status,
      "cancelled",
    );
    assert.equal(
      f.app.store.one("SELECT status FROM approvals WHERE id=?", [approval.id])
        .status,
      "expired",
    );
  } finally {
    await f.app.close();
  }
});

test("provider failure preserves partial output and retry can recover", async () => {
  let attempt = 0,
    recoveryPrompt = "";
  const f = await fixture(async (o) => {
    o.onDelta("Useful partial response.");
    if (!attempt++) throw new Error("Provider test failure");
    recoveryPrompt = o.prompt;
    return { text: "Recovered response." };
  });
  try {
    const a = await f.request("/agents", "POST", worker("Alex"));
    await f.request(`/conversations/${a.conversationId}/messages`, "POST", {
      content: "Inspect this test",
    });
    const t = await until(() =>
      f.app.store.one("SELECT * FROM tasks WHERE status='failed'"),
    );
    assert.equal(
      f.app.store.one("SELECT content FROM messages WHERE role='assistant'")
        .content,
      "Useful partial response.",
    );
    await f.request(`/tasks/${t.id}/retry`, "POST", {});
    await until(() =>
      f.app.store.one("SELECT * FROM tasks WHERE status='completed'"),
    );
    assert.equal(
      f.app.store.one("SELECT result FROM tasks WHERE id=?", [t.id]).result,
      "Recovered response.",
    );
    assert.match(
      recoveryPrompt,
      /Previous attempt ended with: Provider test failure/,
    );
    assert.equal(
      f.app.store.one(
        "SELECT COUNT(*) count FROM events WHERE task_id=? AND type='task.replanned'",
        [t.id],
      ).count,
      1,
    );
  } finally {
    await f.app.close();
  }
});

test("a message during active work becomes durable steering and restarts with that instruction", async () => {
  let calls = 0;
  const f = await fixture(async (o) => {
    calls += 1;
    if (calls === 1)
      return new Promise((resolve, reject) =>
        o.signal.addEventListener(
          "abort",
          () => reject(new Error("Cancelled")),
          { once: true },
        ),
      );
    assert.match(o.prompt, /Do not modify the database schema/);
    assert.match(o.prompt, /Steering attachment evidence/);
    o.onDelta("Applied the new constraint.");
    return { text: "Applied the new constraint." };
  });
  try {
    const a = await f.request("/agents", "POST", worker("Alex"));
    await f.request(`/conversations/${a.conversationId}/messages`, "POST", {
      content: "Inspect the project and fix the login issue.",
    });
    await until(() => f.app.engine.active.size === 1);
    const steered = await f.request(
      `/conversations/${a.conversationId}/messages`,
      "POST",
      {
        content: "Do not modify the database schema.",
        attachments: [
          { name: "constraint.md", content: "Steering attachment evidence" },
        ],
      },
    );
    assert.equal(steered.handling, "steered");
    await until(() =>
      f.app.store.one("SELECT * FROM tasks WHERE status='completed'"),
    );
    assert.equal(
      f.app.store.one("SELECT COUNT(*) count FROM task_instructions").count,
      1,
    );
    assert.equal(calls, 2);
  } finally {
    await f.app.close();
  }
});

test("a follow-up during active work is queued behind the current task", async () => {
  let release;
  const firstDone = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const f = await fixture(async (o) => {
    calls += 1;
    if (calls === 1) {
      await firstDone;
      return { text: "Initial work completed." };
    }
    assert.match(o.prompt, /clean up the related tests/i);
    return { text: "Follow-up completed." };
  });
  try {
    const a = await f.request("/agents", "POST", worker("Alex"));
    await f.request(`/conversations/${a.conversationId}/messages`, "POST", {
      content: "Inspect the project and fix the login issue.",
    });
    await until(() => f.app.engine.active.size === 1);
    const queued = await f.request(
      `/conversations/${a.conversationId}/messages`,
      "POST",
      { content: "After this is done, clean up the related tests." },
    );
    assert.equal(queued.handling, "queued");
    assert.equal(f.app.store.one("SELECT COUNT(*) count FROM tasks").count, 2);
    release();
    await until(
      () =>
        f.app.store.one(
          "SELECT COUNT(*) count FROM tasks WHERE status='completed'",
        ).count === 2,
    );
  } finally {
    await f.app.close();
  }
});

test("work inspection exposes the authorized workspace's real Git change", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "roster-git-test-"));
  execFileSync("git", ["init"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "roster-test@example.invalid"], {
    cwd: workspace,
  });
  execFileSync("git", ["config", "user.name", "Roster test"], {
    cwd: workspace,
  });
  fs.writeFileSync(path.join(workspace, "example.txt"), "before\n");
  execFileSync("git", ["add", "example.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, "example.txt"), "after\n");
  const f = await fixture(async () => ({ text: "Checked the workspace." }));
  try {
    const a = await f.request("/agents", "POST", worker("Alex", { workspace }));
    await f.request(`/conversations/${a.conversationId}/messages`, "POST", {
      content: "Inspect the project.",
    });
    const task = await until(() =>
      f.app.store.one("SELECT * FROM tasks WHERE status='completed'"),
    );
    const inspection = await f.request(`/tasks/${task.id}/inspection`);
    assert.equal(inspection.available, true);
    assert.deepEqual(inspection.files, [{ status: "M", path: "example.txt" }]);
    assert.match(inspection.diff, /-before/);
    assert.match(inspection.diff, /\+after/);
  } finally {
    await f.app.close();
  }
});

test("coding work receives an isolated worktree with a persisted outcome and task-scoped diff", async () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "roster-worktree-test-"),
  );
  execFileSync("git", ["init"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "roster-test@example.invalid"], {
    cwd: workspace,
  });
  execFileSync("git", ["config", "user.name", "Roster test"], {
    cwd: workspace,
  });
  fs.writeFileSync(path.join(workspace, "example.txt"), "before\n");
  execFileSync("git", ["add", "example.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });
  let executionWorkspace = "";
  const f = await fixture(async (o) => {
    executionWorkspace = o.cwd;
    fs.writeFileSync(path.join(o.cwd, "example.txt"), "after\n");
    return { text: "The fix is ready for review." };
  });
  try {
    const a = await f.request("/agents", "POST", worker("Alex", { workspace }));
    await f.request(`/conversations/${a.conversationId}/messages`, "POST", {
      content: "Fix the example file. Do not change the database schema.",
    });
    const task = await until(() =>
      f.app.store.one("SELECT * FROM tasks WHERE status='completed'"),
    );
    assert.notEqual(executionWorkspace, workspace);
    assert.equal(task.worktree_path, executionWorkspace);
    assert.match(task.branch, /^roster\/task-/);
    assert.equal(
      fs.readFileSync(path.join(workspace, "example.txt"), "utf8"),
      "before\n",
    );
    assert.equal(
      f.app.store.one("SELECT goal FROM outcome_contracts WHERE task_id=?", [
        task.id,
      ]).goal,
      task.objective,
    );
    const taskSummary = (await f.request("/state")).tasks.find(
      (item) => item.id === task.id,
    );
    assert.equal(taskSummary.criteria_total, 2);
    assert.equal(taskSummary.criteria_passed, 0);
    const inspection = await f.request(`/tasks/${task.id}/inspection`);
    assert.match(inspection.diff, /after/);
    const handoff = await f.request(
      `/tasks/${task.id}/integration-ready`,
      "POST",
      {},
    );
    assert.match(
      f.app.store.one("SELECT content FROM artifacts WHERE id=?", [
        handoff.artifactId,
      ]).content,
      /after/,
    );
    assert.equal(handoff.integration.status, "ready");
    assert.equal(
      f.app.store.one("SELECT type FROM attention_items WHERE task_id=?", [
        task.id,
      ]).type,
      "integration",
    );
    fs.writeFileSync(path.join(workspace, "example.txt"), "user update\n");
    execFileSync("git", ["add", "example.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "user change"], { cwd: workspace });
    const conflicting = await f.request(
      `/tasks/${task.id}/integration-ready`,
      "POST",
      {},
    );
    assert.equal(conflicting.integration.status, "conflict");
    assert.equal(
      f.app.store.one(
        "SELECT type FROM attention_items WHERE task_id=? ORDER BY rowid DESC",
        [task.id],
      ).type,
      "integration_conflict",
    );
  } finally {
    await f.app.close();
  }
});

test("restart preserves queued dependency work and marks in-flight work resumable", async () => {
  const f = await fixture(async () => ({ text: "Recovered queued work." }));
  let restarted;
  try {
    const a = await f.request("/agents", "POST", worker("Alex"));
    const timestamp = new Date().toISOString();
    f.app.store.run(
      "INSERT INTO tasks(id,conversation_id,owner_id,title,objective,status,kind,workspace,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [
        "00000000-0000-4000-8000-000000000001",
        a.conversationId,
        a.id,
        "Interrupted work",
        "Resume this work",
        "running",
        "work",
        "",
        timestamp,
      ],
    );
    f.app.store.run(
      "INSERT INTO tasks(id,conversation_id,owner_id,title,objective,status,kind,workspace,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [
        "00000000-0000-4000-8000-000000000002",
        a.conversationId,
        a.id,
        "Queued work",
        "Complete queued work",
        "queued",
        "work",
        "",
        timestamp,
      ],
    );
    await f.app.close();
    restarted = await createServer({
      directory: f.directory,
      port: 0,
      runner: async () => ({ text: "Recovered queued work." }),
    });
    assert.equal(
      restarted.store.one("SELECT status FROM tasks WHERE id=?", [
        "00000000-0000-4000-8000-000000000001",
      ]).status,
      "interrupted",
    );
    await until(
      () =>
        restarted.store.one("SELECT status FROM tasks WHERE id=?", [
          "00000000-0000-4000-8000-000000000002",
        ]).status === "completed",
    );
  } finally {
    if (restarted) await restarted.close();
    else if (f.app.server.listening) await f.app.close();
  }
});

test("desktop shutdown preserves active work as interrupted and resumable", async () => {
  const f = await fixture(
    async (o) =>
      new Promise((resolve, reject) =>
        o.signal.addEventListener(
          "abort",
          () => reject(new Error("Cancelled")),
          { once: true },
        ),
      ),
  );
  let closed = false,
    restarted;
  try {
    const a = await f.request("/agents", "POST", worker("Alex"));
    await f.request(`/conversations/${a.conversationId}/messages`, "POST", {
      content: "Implement a small change.",
    });
    await until(() => f.app.engine.active.size === 1);
    await f.app.close();
    closed = true;
    restarted = await createServer({
      directory: f.directory,
      port: 0,
      runner: async () => ({ text: "Unused" }),
    });
    const task = restarted.store.one("SELECT * FROM tasks");
    assert.equal(task.status, "interrupted");
    assert.match(task.error, /Saved progress and instructions are preserved/);
  } finally {
    if (restarted) await restarted.close();
    if (!closed && f.app.server.listening) await f.app.close();
  }
});

test("invalid team graph cannot create hallucinated workers, forward edges or cycles", () => {
  const members = [{ id: "real" }];
  assert.throws(() =>
    validatePlan(
      {
        type: "task",
        assignments: [
          { agent_id: "fake", objective: "Bad", depends_on: [], kind: "work" },
        ],
      },
      members,
    ),
  );
  assert.throws(() =>
    validatePlan(
      {
        type: "task",
        assignments: [
          { agent_id: "real", objective: "Bad", depends_on: [0], kind: "work" },
        ],
      },
      members,
    ),
  );
});

test("cross-site access, invalid workspace and foreign chat replies are rejected", async () => {
  const f = await fixture(async () => ({ text: "ok" }));
  try {
    const cross = await fetch(f.app.url + "/api/state", {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(cross.status, 403);
    const localCross = await fetch(f.app.url + "/api/state", {
      headers: { Origin: "http://127.0.0.1:49152" },
    });
    assert.equal(localCross.status, 403);
    await assert.rejects(
      f.request(
        "/agents",
        "POST",
        worker("Nope", { workspace: "Z:/roster/nonexistent" }),
      ),
    );
    assert.equal(f.app.snapshot().agents.length, 0);
    const a = await f.request("/agents", "POST", worker("Alex")),
      b = await f.request("/agents", "POST", worker("Sam"));
    const mid = f.app.engine.message(
      b.conversationId,
      "user",
      "Foreign message",
    );
    await assert.rejects(
      f.request(`/conversations/${a.conversationId}/messages`, "POST", {
        content: "Invalid reply",
        replyTo: mid,
      }),
    );
    assert.equal(
      f.app.store.all("SELECT * FROM messages WHERE conversation_id=?", [
        a.conversationId,
      ]).length,
      0,
    );
  } finally {
    await f.app.close();
  }
});

test("disconnecting a compatible provider clears its endpoint-bound key", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roster-key-test-"));
  let saved = "";
  const vault = {
    mode: "test",
    get: () => saved,
    set: (value) => {
      saved = value;
    },
  };
  const app = await createServer({
    directory,
    port: 0,
    vault,
    runner: async () => ({ text: "ok" }),
  });
  try {
    const post = async (body) => {
      const result = await fetch(app.url + "/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(result.status, 200);
    };
    await post({
      compatible: {
        name: "OpenAI",
        endpoint: "https://api.openai.com/v1",
        model: "gpt-5",
      },
      apiKey: "test-provider-key",
    });
    assert.equal(saved, "test-provider-key");
    await post({ compatible: null });
    assert.equal(saved, "");
    assert.equal(app.store.setting("keyOrigin"), null);
  } finally {
    await app.close();
  }
});

test("integration refresh persists scoped engineering tool status without credentials", async () => {
  const f = await fixture(async () => ({ text: "unused" }));
  try {
    const refreshed = await f.request("/integrations/refresh", "POST", {});
    assert.equal(refreshed.integrations.length, 9);
    const github = refreshed.integrations.find(
      (item) => item.provider === "github",
    );
    const playwright = refreshed.integrations.find(
      (item) => item.provider === "playwright",
    );
    assert.ok(
      ["connected", "authentication_required", "unavailable"].includes(
        github.status,
      ),
    );
    assert.equal(playwright.status, "available");
    assert.equal(
      f.app.store.one("SELECT COUNT(*) count FROM integration_tools").count,
      9,
    );
  } finally {
    await f.app.close();
  }
});

test("MCP discovery records public capabilities and authorization metadata without tokens", async () => {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const origin = `http://${req.headers.host}`;
      const request = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      if (req.url === "/secure") {
        res.writeHead(401, {
          "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/secure"`,
        });
        return res.end();
      }
      if (req.url === "/.well-known/oauth-protected-resource/secure") {
        res.setHeader("Content-Type", "application/json");
        return res.end(
          JSON.stringify({
            authorization_servers: ["https://login.example.com"],
            scopes_supported: ["issues:read"],
          }),
        );
      }
      if (req.url === "/public" && request.method === "initialize") {
        res.setHeader("Content-Type", "application/json");
        return res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "roster-discovery",
            result: {
              protocolVersion: "2025-11-25",
              serverInfo: { name: "Local MCP" },
              capabilities: { tools: {} },
            },
          }),
        );
      }
      if (
        req.url === "/public" &&
        request.method === "notifications/initialized"
      ) {
        res.writeHead(202);
        return res.end();
      }
      if (req.url === "/public" && request.method === "tools/list") {
        res.setHeader("Content-Type", "application/json");
        return res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "roster-tools",
            result: {
              tools: [
                {
                  name: "issues.read",
                  description: "Read issue context",
                  inputSchema: { type: "object" },
                },
              ],
            },
          }),
        );
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const f = await fixture(async () => ({ text: "unused" }));
  try {
    const secure = await f.request("/mcp/discover", "POST", {
      url: `http://127.0.0.1:${port}/secure`,
    });
    assert.equal(secure.status, "authentication_required");
    assert.deepEqual(secure.authMetadata.scopes_supported, ["issues:read"]);
    const publicServer = await f.request("/mcp/discover", "POST", {
      url: `http://127.0.0.1:${port}/public`,
    });
    assert.equal(publicServer.serverName, "Local MCP");
    assert.deepEqual(publicServer.capabilities, ["tools"]);
    assert.equal(publicServer.tools[0].name, "issues.read");
    const state = await f.request("/state");
    assert.equal(state.mcpConnections.length, 2);
    assert.equal(
      JSON.parse(
        state.mcpConnections.find(
          (connection) => connection.server_name === "Local MCP",
        ).tools_json,
      )[0].name,
      "issues.read",
    );
  } finally {
    await f.app.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("project inspection discovers local scripts and instruction files", async () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "roster-project-test-"),
  );
  fs.writeFileSync(
    path.join(workspace, "package.json"),
    JSON.stringify({
      name: "sample",
      scripts: { test: "node --test", build: "vite build" },
    }),
  );
  fs.writeFileSync(path.join(workspace, "package-lock.json"), "{}");
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "Use focused tests.");
  const f = await fixture(async () => ({ text: "unused" }));
  try {
    const project = await f.request("/projects/inspect", "POST", { workspace });
    assert.equal(project.name, "sample");
    assert.equal(project.instructions[0].name, "AGENTS.md");
    assert.equal(project.scripts.length, 2);
  } finally {
    await f.app.close();
  }
});

test("an explicitly saved project profile supplies bounded instructions to later work", async () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "roster-profile-test-"),
  );
  fs.writeFileSync(
    path.join(workspace, "package.json"),
    JSON.stringify({ name: "profiled-app", scripts: { test: "node --test" } }),
  );
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "Run the focused test.");
  let prompt = "";
  const f = await fixture(async (options) => {
    prompt = options.prompt;
    return { text: "Completed the requested work." };
  });
  try {
    const profile = await f.request("/projects/profile", "POST", { workspace });
    assert.equal(profile.name, "profiled-app");
    const a = await f.request("/agents", "POST", worker("Alex", { workspace }));
    await f.request(`/conversations/${a.conversationId}/messages`, "POST", {
      content: "Implement the requested change.",
    });
    await until(
      () =>
        f.app.store.one("SELECT status FROM tasks ORDER BY rowid DESC")
          ?.status === "completed",
    );
    assert.match(prompt, /Project profile: profiled-app/);
    assert.match(prompt, /Run the focused test/);
    assert.match(prompt, /Definition of done/);
    assert.match(prompt, /The requested outcome is addressed/);
  } finally {
    await f.app.close();
  }
});

test("message reactions are local, durable, and toggleable", async () => {
  const f = await fixture(async () => ({ text: "response" }));
  try {
    const a = await f.request("/agents", "POST", worker("Alex"));
    const sent = await f.request(
      `/conversations/${a.conversationId}/messages`,
      "POST",
      { content: "Hello" },
    );
    await f.request(`/messages/${sent.id}/reactions`, "POST", { emoji: "👍" });
    let messages = await f.request(
      `/conversations/${a.conversationId}/messages`,
    );
    assert.deepEqual(
      messages.find((message) => message.id === sent.id).reactions,
      ["👍"],
    );
    await f.request(`/messages/${sent.id}/reactions`, "POST", { emoji: "👍" });
    messages = await f.request(`/conversations/${a.conversationId}/messages`);
    assert.deepEqual(
      messages.find((message) => message.id === sent.id).reactions,
      [],
    );
  } finally {
    await f.app.close();
  }
});

test("conversation mute persists as a local preference", async () => {
  const f = await fixture(async () => ({ text: "response" }));
  try {
    const a = await f.request("/agents", "POST", worker("Alex"));
    await f.request(`/conversations/${a.conversationId}`, "PATCH", {
      muted: true,
    });
    assert.equal(
      (await f.request("/state")).conversations.find(
        (conversation) => conversation.id === a.conversationId,
      ).muted,
      1,
    );
  } finally {
    await f.app.close();
  }
});

test("conversation can be marked unread and resets when read", async () => {
  const f = await fixture(async () => ({ text: "response" }));
  try {
    const a = await f.request("/agents", "POST", worker("Alex"));
    f.app.store.run(
      "INSERT INTO messages(id,conversation_id,agent_id,role,content,kind,status,created_at) VALUES(?,?,?,?,?,?,?,?)",
      [
        "00000000-0000-4000-8000-000000000204",
        a.conversationId,
        a.id,
        "assistant",
        "A saved update.",
        "text",
        "complete",
        new Date().toISOString(),
      ],
    );
    await f.request(`/conversations/${a.conversationId}`, "PATCH", {
      markUnread: true,
    });
    assert.equal(
      (await f.request("/state")).conversations.find(
        (conversation) => conversation.id === a.conversationId,
      ).unread,
      1,
    );
    await f.request(`/conversations/${a.conversationId}`, "PATCH", {
      read: true,
    });
    assert.equal(
      (await f.request("/state")).conversations.find(
        (conversation) => conversation.id === a.conversationId,
      ).unread,
      0,
    );
  } finally {
    await f.app.close();
  }
});

test("needs you items resolve without deleting task history", async () => {
  const f = await fixture(async () => ({ text: "response" }));
  try {
    const a = await f.request("/agents", "POST", worker("Alex"));
    const taskId = "00000000-0000-4000-8000-000000000199";
    const attentionId = "00000000-0000-4000-8000-000000000200";
    f.app.store.run(
      "INSERT INTO tasks(id,conversation_id,owner_id,title,objective,status,kind,created_at) VALUES(?,?,?,?,?,?,?,?)",
      [
        taskId,
        a.conversationId,
        a.id,
        "Task",
        "Task",
        "completed",
        "work",
        new Date().toISOString(),
      ],
    );
    f.app.store.run(
      "INSERT INTO attention_items(id,task_id,type,title,detail,created_at) VALUES(?,?,?,?,?,?)",
      [
        attentionId,
        taskId,
        "integration",
        "Ready",
        "Review patch",
        new Date().toISOString(),
      ],
    );
    await f.request(`/attention/${attentionId}/resolve`, "POST", {});
    assert.equal(
      f.app.store.one("SELECT status FROM attention_items WHERE id=?", [
        attentionId,
      ]).status,
      "resolved",
    );
    assert.ok(f.app.store.one("SELECT id FROM tasks WHERE id=?", [taskId]));
  } finally {
    await f.app.close();
  }
});

test("weekly digest uses only persisted verified outcome facts", async () => {
  const f = await fixture(async () => ({ text: "response" }));
  try {
    const a = await f.request("/agents", "POST", worker("Alex"));
    f.app.store.run(
      "INSERT INTO tasks(id,conversation_id,owner_id,title,objective,status,kind,verification,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [
        "00000000-0000-4000-8000-000000000099",
        a.conversationId,
        a.id,
        "Verified task",
        "Finish it",
        "completed",
        "work",
        "verified",
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    const digest = await f.request("/digest/weekly");
    assert.equal(digest.verifiedCount, 1);
    assert.equal(digest.outcomes[0].title, "Verified task");
  } finally {
    await f.app.close();
  }
});

test("verified work receipts download as Markdown", async () => {
  const f = await fixture(async () => ({ text: "response" }));
  try {
    const a = await f.request("/agents", "POST", worker("Alex"));
    const taskId = "00000000-0000-4000-8000-000000000299";
    f.app.store.run(
      "INSERT INTO tasks(id,conversation_id,owner_id,title,objective,status,kind,verification,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [
        taskId,
        a.conversationId,
        a.id,
        "Receipt task",
        "Task",
        "completed",
        "work",
        "verified",
        new Date().toISOString(),
      ],
    );
    f.app.store.run(
      "INSERT INTO work_receipts(id,task_id,content,created_at) VALUES(?,?,?,?)",
      [
        "00000000-0000-4000-8000-000000000300",
        taskId,
        "# Receipt task\n\nVerified.",
        new Date().toISOString(),
      ],
    );
    const response = await fetch(`${f.app.url}/api/tasks/${taskId}/receipt`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Verified/);
    assert.match(response.headers.get("content-disposition"), /Receipt%20task/);
  } finally {
    await f.app.close();
  }
});

test("users can add an explicit outcome acceptance criterion", async () => {
  const f = await fixture(async () => ({ text: "response" }));
  try {
    const a = await f.request("/agents", "POST", worker("Alex"));
    await f.request(`/conversations/${a.conversationId}/messages`, "POST", {
      content: "Fix the sample issue.",
    });
    const task = await until(() =>
      f.app.store.one("SELECT * FROM tasks WHERE status='completed'"),
    );
    const outcome = f.app.store.one(
      "SELECT * FROM outcome_contracts WHERE task_id=?",
      [task.id],
    );
    await f.request(`/outcomes/${outcome.id}/criteria`, "POST", {
      type: "test",
      description: "The regression test passes",
    });
    assert.equal(
      f.app.store.one(
        "SELECT COUNT(*) count FROM acceptance_criteria WHERE outcome_id=?",
        [outcome.id],
      ).count,
      3,
    );
  } finally {
    await f.app.close();
  }
});

test("criterion evidence is retained as outcome evidence", async () => {
  const f = await fixture(async () => ({ text: "response" }));
  try {
    const a = await f.request("/agents", "POST", worker("Alex"));
    await f.request(`/conversations/${a.conversationId}/messages`, "POST", {
      content: "Fix the sample issue.",
    });
    const task = await until(() =>
      f.app.store.one("SELECT * FROM tasks WHERE status='completed'"),
    );
    const outcome = f.app.store.one(
      "SELECT * FROM outcome_contracts WHERE task_id=?",
      [task.id],
    );
    const criterion = f.app.store.one(
      "SELECT * FROM acceptance_criteria WHERE outcome_id=?",
      [outcome.id],
    );
    await f.request(`/criteria/${criterion.id}/record`, "POST", {
      status: "pass",
      evidence: "The focused test completed successfully.",
    });
    assert.equal(
      f.app.store.one("SELECT status FROM acceptance_criteria WHERE id=?", [
        criterion.id,
      ]).status,
      "pass",
    );
    assert.equal(
      f.app.store.one(
        "SELECT COUNT(*) count FROM evidence WHERE outcome_id=?",
        [outcome.id],
      ).count,
      2,
    );
  } finally {
    await f.app.close();
  }
});

test(
  "Windows secret persistence uses DPAPI and does not store the cleartext key",
  { skip: process.platform !== "win32" },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roster-vault-test-"));
    const vault = createVault(dir);
    vault.set("test-only-secret-not-a-real-key");
    const disk = fs.readFileSync(
      path.join(dir, "web-provider-key.enc"),
      "utf8",
    );
    assert.ok(!disk.includes("test-only-secret"));
    assert.equal(createVault(dir).get(), "test-only-secret-not-a-real-key");
    vault.set("");
    assert.equal(fs.existsSync(path.join(dir, "web-provider-key.enc")), false);
  },
);
