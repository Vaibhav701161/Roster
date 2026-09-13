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

async function fixture(runner, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roster-test-"));
  const app = await createServer({ directory, port: 0, runner, ...options });
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
  fs.writeFileSync(path.join(workspace, ".gitignore"), ".env.local\n");
  execFileSync("git", ["add", "example.txt", ".gitignore"], {
    cwd: workspace,
  });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, ".env.local"), "LOCAL_ONLY=true\n");
  let executionWorkspace = "";
  let copiedEnvironment = "";
  const integrationCommands = [];
  const f = await fixture(
    async (o) => {
      executionWorkspace = o.cwd;
      copiedEnvironment = fs.readFileSync(
        path.join(o.cwd, ".env.local"),
        "utf8",
      );
      fs.writeFileSync(path.join(o.cwd, "example.txt"), "after\n");
      return { text: "The fix is ready for review." };
    },
    {
      integrationCommand: async (command, args, options) => {
        integrationCommands.push({ command, args, options });
        return JSON.stringify({
          findings: [
            {
              severity: "medium",
              description: "Handle the release edge case.",
            },
          ],
        });
      },
    },
  );
  try {
    await f.request("/projects/profile", "POST", { workspace });
    const a = await f.request("/agents", "POST", worker("Alex", { workspace }));
    await f.request(`/conversations/${a.conversationId}/messages`, "POST", {
      content: "Fix the example file. Do not change the database schema.",
    });
    const task = await until(() =>
      f.app.store.one("SELECT * FROM tasks WHERE status='completed'"),
    );
    assert.notEqual(executionWorkspace, workspace);
    assert.equal(copiedEnvironment, "LOCAL_ONLY=true\n");
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
    assert.deepEqual(
      JSON.parse(
        f.app.store.one(
          "SELECT detail FROM events WHERE task_id=? AND type='worktree.created'",
          [task.id],
        ).detail,
      ).copiedEnvironmentFiles,
      [".env.local"],
    );
    await f.request("/integrations/refresh", "POST", {});
    f.app.store.run(
      "UPDATE integrations SET status='available' WHERE provider='coderabbit'",
    );
    const codeRabbit = await f.request(
      `/tasks/${task.id}/coderabbit-review`,
      "POST",
      {},
    );
    assert.match(codeRabbit.summary, /1 structured result.*1 finding/);
    assert.deepEqual(integrationCommands, [
      {
        command: "coderabbit",
        args: ["review", "--agent"],
        options: {
          cwd: executionWorkspace,
          timeout: 600000,
          maxBuffer: 500000,
        },
      },
    ]);
    assert.match(
      f.app.store.one("SELECT content FROM artifacts WHERE id=?", [
        codeRabbit.artifactId,
      ]).content,
      /Handle the release edge case/,
    );
    assert.equal(
      f.app.store.one("SELECT status FROM evidence WHERE id=?", [
        codeRabbit.evidenceId,
      ]).status,
      "observed",
    );
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
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "roster-integration-scope-"),
    );
    await assert.rejects(
      () =>
        f.request(`/integrations/${github.id}/scopes`, "PUT", {
          workspaces: [workspace],
        }),
      /Save this project as a profile/,
    );
    await f.request("/projects/profile", "POST", { workspace });
    const scoped = await f.request(`/integrations/${github.id}/scopes`, "PUT", {
      workspaces: [workspace],
    });
    assert.deepEqual(JSON.parse(scoped.workspace_scope_json), [workspace]);
    f.app.store.run(
      "UPDATE integrations SET status='authentication_required',detail='Sign in to continue.' WHERE id=?",
      [github.id],
    );
    await f.request(`/integrations/${github.id}/scopes`, "PUT", {
      workspaces: [workspace],
    });
    assert.equal(
      (await f.request("/state")).needsYou.some(
        (item) => item.type === "integration_github" && item.status === "open",
      ),
      true,
    );
    f.app.store.run(
      "UPDATE integrations SET status='connected',detail='Connected.' WHERE id=?",
      [github.id],
    );
    await f.request(`/integrations/${github.id}/scopes`, "PUT", {
      workspaces: [workspace],
    });
    assert.equal(
      (await f.request("/state")).needsYou.some(
        (item) => item.type === "integration_github" && item.status === "open",
      ),
      false,
    );
  } finally {
    await f.app.close();
  }
});

test("native integration tokens stay in the vault and are verified without entering application state", async () => {
  const secrets = new Map();
  const calls = [];
  const vault = {
    mode: "test",
    get: () => "",
    set: () => {},
    getNamed: (key) => secrets.get(key) || "",
    setNamed: (key, value) => secrets.set(key, value),
  };
  const f = await fixture(async () => ({ text: "unused" }), {
    vault,
    integrationFetch: async (url, options) => {
      calls.push({ url, options });
      if (String(options.body || "").includes("RosterIssueSearch"))
        return new Response(
          JSON.stringify({
            data: {
              searchIssues: {
                nodes: [
                  {
                    id: "issue",
                    identifier: "ENG-42",
                    title: "Bounded search result",
                    state: { name: "In progress" },
                    priority: 2,
                    updatedAt: "2026-01-01T00:00:00.000Z",
                    url: "https://linear.app/example/issue/ENG-42",
                  },
                ],
              },
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      if (url === "https://api.linear.app/graphql")
        return new Response(
          JSON.stringify({ data: { viewer: { id: "user" } } }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      return new Response("{}", { status: 401 });
    },
  });
  try {
    const integrations = await f.request("/integrations/refresh", "POST", {});
    const linear = integrations.integrations.find(
      (item) => item.provider === "linear",
    );
    await f.request(`/integrations/${linear.id}/token`, "PUT", {
      token: "linear-test-token",
    });
    assert.equal(secrets.get("integration:linear:token"), "linear-test-token");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.linear.app/graphql");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(
      calls[0].options.headers.Authorization,
      "Bearer linear-test-token",
    );
    const state = await f.request("/state");
    const connected = state.integrations.find(
      (item) => item.provider === "linear",
    );
    assert.equal(connected.status, "connected");
    assert.equal(connected.credential_configured, true);
    const read = await f.request(`/integrations/${linear.id}/read`, "POST", {
      query: "checkout",
    });
    assert.equal(read.result[0].identifier, "ENG-42");
    assert.equal(calls.length, 2);
    assert.equal(JSON.stringify(state).includes("linear-test-token"), false);
    assert.equal(
      JSON.stringify(f.app.store.all("SELECT * FROM integrations")).includes(
        "linear-test-token",
      ),
      false,
    );
    await f.request(`/integrations/${linear.id}/token`, "PUT", { token: "" });
    assert.equal(secrets.get("integration:linear:token"), "");
    assert.equal(
      (await f.request("/state")).integrations.find(
        (item) => item.provider === "linear",
      ).credential_configured,
      false,
    );
  } finally {
    await f.app.close();
  }
});

test("Slack and Notion expose bounded read-only project context", async () => {
  const secrets = new Map();
  const calls = [];
  const vault = {
    mode: "test",
    get: () => "",
    set: () => {},
    getNamed: (key) => secrets.get(key) || "",
    setNamed: (key, value) => secrets.set(key, value),
  };
  const f = await fixture(async () => ({ text: "unused" }), {
    vault,
    integrationFetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).startsWith("https://slack.com/api/search.messages"))
        return new Response(
          JSON.stringify({
            ok: true,
            messages: {
              matches: [
                {
                  iid: "slack-result",
                  channel: { id: "C1", name: "shipping" },
                  username: "Alex",
                  text: "Checkout release is ready.",
                  ts: "1760000000.000001",
                  permalink: "https://slack.example/archives/C1/p1",
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      if (String(url) === "https://slack.com/api/auth.test")
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (String(url) === "https://api.notion.com/v1/search")
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "notion-result",
                object: "page",
                title: [{ plain_text: "Checkout launch decision" }],
                last_edited_time: "2026-01-01T00:00:00.000Z",
                url: "https://notion.so/notion-result",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      if (String(url) === "https://api.notion.com/v1/users/me")
        return new Response(JSON.stringify({ id: "notion-user" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      return new Response("{}", { status: 401 });
    },
  });
  try {
    const refreshed = await f.request("/integrations/refresh", "POST", {});
    const slack = refreshed.integrations.find(
      (item) => item.provider === "slack",
    );
    const notion = refreshed.integrations.find(
      (item) => item.provider === "notion",
    );
    await f.request(`/integrations/${slack.id}/token`, "PUT", {
      token: "slack-test-token",
    });
    await f.request(`/integrations/${notion.id}/token`, "PUT", {
      token: "notion-test-token",
    });
    const slackRead = await f.request(
      `/integrations/${slack.id}/read`,
      "POST",
      {
        query: "checkout",
      },
    );
    const notionRead = await f.request(
      `/integrations/${notion.id}/read`,
      "POST",
      { query: "checkout" },
    );
    assert.equal(slackRead.result[0].channel, "shipping");
    assert.equal(notionRead.result[0].title, "Checkout launch decision");
    const slackSearch = calls.find((call) =>
      call.url.startsWith("https://slack.com/api/search.messages"),
    );
    assert.match(slackSearch.url, /query=checkout/);
    assert.equal(
      slackSearch.options.headers.Authorization,
      "Bearer slack-test-token",
    );
    const notionSearch = calls.find(
      (call) => call.url === "https://api.notion.com/v1/search",
    );
    assert.equal(notionSearch.options.method, "POST");
    assert.equal(notionSearch.options.headers["Notion-Version"], "2025-09-03");
    assert.equal(
      JSON.stringify(await f.request("/state")).includes("slack-test-token"),
      false,
    );
    assert.equal(
      JSON.stringify(await f.request("/state")).includes("notion-test-token"),
      false,
    );
  } finally {
    await f.app.close();
  }
});

test("Vercel and Supabase use bounded local CLI reads", async () => {
  const commands = [];
  const f = await fixture(async () => ({ text: "unused" }), {
    integrationCommand: async (command, args) => {
      commands.push({ command, args });
      if (command === "vercel")
        return JSON.stringify({
          projects: [
            {
              id: "vercel-project",
              name: "roster-web",
              framework: "vite",
              updatedAt: "2026-01-01T00:00:00.000Z",
              link: { deploymentUrl: "roster-web.vercel.app" },
            },
          ],
        });
      if (command === "supabase")
        return JSON.stringify([
          {
            id: "supabase-project",
            ref: "abcdefghijklmnopqrst",
            name: "Roster production",
            region: "ap-south-1",
            status: "ACTIVE_HEALTHY",
          },
        ]);
      return "";
    },
  });
  try {
    const refreshed = await f.request("/integrations/refresh", "POST", {});
    const vercel = refreshed.integrations.find(
      (item) => item.provider === "vercel",
    );
    const supabase = refreshed.integrations.find(
      (item) => item.provider === "supabase",
    );
    const vercelRead = await f.request(
      `/integrations/${vercel.id}/read`,
      "POST",
      {},
    );
    const supabaseRead = await f.request(
      `/integrations/${supabase.id}/read`,
      "POST",
      {},
    );
    assert.equal(vercelRead.result[0].name, "roster-web");
    assert.equal(supabaseRead.result[0].region, "ap-south-1");
    assert.deepEqual(commands, [
      { command: "vercel", args: ["project", "ls", "--json"] },
      {
        command: "supabase",
        args: ["projects", "list", "--output", "json"],
      },
    ]);
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "roster-integration-read-scope-"),
    );
    await f.request("/projects/profile", "POST", { workspace });
    await f.request(`/integrations/${vercel.id}/scopes`, "PUT", {
      workspaces: [workspace],
    });
    await assert.rejects(
      () => f.request(`/integrations/${vercel.id}/read`, "POST", {}),
      /Select a project allowed/,
    );
    await f.request(`/integrations/${vercel.id}/read`, "POST", { workspace });
    assert.equal(commands.length, 3);
  } finally {
    await f.app.close();
  }
});

test("Sentry watch baselines known issues and escalates only newly observed ones", async () => {
  const secrets = new Map();
  let issueId = "known";
  const vault = {
    mode: "test",
    get: () => "",
    set: () => {},
    getNamed: (key) => secrets.get(key) || "",
    setNamed: (key, value) => secrets.set(key, value),
  };
  const f = await fixture(async () => ({ text: "unused" }), {
    vault,
    integrationFetch: async (url) => {
      if (String(url).includes("/organizations/acme/issues/"))
        return new Response(
          JSON.stringify([
            {
              id: issueId,
              title: `${issueId} failure`,
              level: "error",
              count: 3,
              lastSeen: "2026-01-01T00:00:00.000Z",
              permalink: "https://sentry.example/issues/1",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      return new Response("{}", { status: 200 });
    },
  });
  try {
    const integrations = await f.request("/integrations/refresh", "POST", {});
    const sentry = integrations.integrations.find(
      (item) => item.provider === "sentry",
    );
    await f.request(`/integrations/${sentry.id}/token`, "PUT", {
      token: "sentry-test-token",
    });
    await f.request(`/integrations/${sentry.id}/sentry-watch`, "PUT", {
      enabled: true,
      organization: "acme",
    });
    assert.equal((await f.request("/state")).needsYou.length, 0);
    issueId = "new";
    await f.request(
      `/integrations/${sentry.id}/sentry-watch/check`,
      "POST",
      {},
    );
    assert.equal(
      (await f.request("/state")).needsYou.some(
        (item) => item.type === "sentry_issue_new",
      ),
      true,
    );
  } finally {
    await f.app.close();
  }
});

test("GitHub pull request ownership persists actionable CI and review state", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "roster-github-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: workspace,
  });
  execFileSync("git", ["config", "user.name", "Roster test"], {
    cwd: workspace,
  });
  fs.writeFileSync(path.join(workspace, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });
  let pullRequest = {
    number: 482,
    url: "https://github.com/owner/project/pull/482",
    state: "OPEN",
    isDraft: false,
    mergeStateStatus: "CLEAN",
    reviewDecision: "CHANGES_REQUESTED",
    statusCheckRollup: [],
  };
  const f = await fixture(async () => ({ text: "Implementation complete." }), {
    githubClient: {
      repositoryFromWorkspace: async () => "owner/project",
      inspectPullRequest: async () => pullRequest,
      createPullRequest: async (task, body) => {
        assert.equal(task.id.length, 36);
        assert.match(body.title, /GitHub ownership fixture/);
        return {
          repository: "owner/project",
          number: 482,
          url: "https://github.com/owner/project/pull/482",
        };
      },
    },
  });
  try {
    const alex = await f.request(
      "/agents",
      "POST",
      worker("Alex", { workspace }),
    );
    await f.request(`/conversations/${alex.conversationId}/messages`, "POST", {
      content: "Fix the GitHub ownership fixture.",
    });
    const task = await until(() =>
      f.app.store.one("SELECT * FROM tasks WHERE status='completed'"),
    );
    const published = await f.request(
      `/tasks/${task.id}/github-pull-request/create`,
      "POST",
      {
        title: "GitHub ownership fixture",
        body: "Prepared in Roster's isolated task worktree.",
      },
    );
    assert.equal(published.pullRequest.number, 482);
    const monitored = await f.request(
      `/tasks/${task.id}/github-pull-request`,
      "POST",
      { number: 482 },
    );
    assert.equal(monitored.status, "needs_attention");
    assert.match(monitored.detail, /Review changes/);
    const attention = f.app.store.one(
      "SELECT * FROM attention_items WHERE task_id=? AND status='open'",
      [task.id],
    );
    assert.equal(attention.type, "github_review");
    const repair = await f.request(
      `/attention/${attention.id}/repair`,
      "POST",
      {},
    );
    const repairTask = await until(() =>
      f.app.store.one("SELECT * FROM tasks WHERE id=? AND status='completed'", [
        repair.repairId,
      ]),
    );
    assert.equal(repairTask.worktree_path, task.worktree_path);
    assert.equal(
      f.app.store.one("SELECT verification FROM tasks WHERE id=?", [task.id])
        .verification,
      "needs_repair",
    );
    pullRequest = { ...pullRequest, state: "MERGED", reviewDecision: "" };
    await f.request(
      `/tasks/${task.id}/github-pull-request/refresh`,
      "POST",
      {},
    );
    assert.equal(
      f.app.store.one("SELECT status FROM github_ownership WHERE task_id=?", [
        task.id,
      ]).status,
      "merged",
    );
    assert.equal(
      f.app.store.one(
        "SELECT COUNT(*) count FROM attention_items WHERE task_id=? AND status='open'",
        [task.id],
      ).count,
      0,
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
      if (req.url === "/public" && request.method === "tools/call") {
        assert.equal(request.params.name, "issues.read");
        assert.deepEqual(request.params.arguments, { issue: 42 });
        res.setHeader("Content-Type", "application/json");
        return res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "roster-tool-call",
            result: {
              content: [{ type: "text", text: "Issue 42 is open." }],
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
    const scopedWorkspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "roster-mcp-scope-"),
    );
    const scoped = await f.request(`/mcp/${publicServer.id}/scopes`, "PUT", {
      workspaces: [scopedWorkspace],
    });
    assert.deepEqual(JSON.parse(scoped.workspace_scope_json), [
      scopedWorkspace,
    ]);
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
    const toolCall = await f.request(
      `/mcp/${publicServer.id}/tools/call`,
      "POST",
      {
        name: "issues.read",
        arguments: { issue: 42 },
        workspace: scopedWorkspace,
      },
    );
    assert.equal(toolCall.result.content[0].text, "Issue 42 is open.");
    assert.deepEqual(
      JSON.parse(
        f.app.store.one(
          "SELECT argument_keys_json FROM mcp_tool_calls WHERE id=?",
          [toolCall.id],
        ).argument_keys_json,
      ),
      ["issue"],
    );
    const agent = await f.request(
      "/agents",
      "POST",
      worker("MCP evidence worker", { workspace: scopedWorkspace }),
    );
    await f.request(`/conversations/${agent.conversationId}/messages`, "POST", {
      content: "Fix the sample issue and collect external evidence.",
    });
    const task = await until(() =>
      f.app.store.one(
        "SELECT * FROM tasks WHERE workspace=? AND status='completed'",
        [scopedWorkspace],
      ),
    );
    const evidence = await f.request(`/tasks/${task.id}/mcp-evidence`, "POST", {
      connectionId: publicServer.id,
      name: "issues.read",
      arguments: { issue: 42 },
    });
    assert.equal(evidence.result.content[0].text, "Issue 42 is open.");
    assert.equal(
      f.app.store.one(
        "SELECT status FROM evidence WHERE task_id=? AND type='external_tool'",
        [task.id],
      ).status,
      "informational",
    );
    assert.equal(
      f.app.store.one(
        "SELECT c.status FROM acceptance_criteria c JOIN outcome_contracts o ON o.id=c.outcome_id WHERE o.task_id=? AND c.type='external_tool'",
        [task.id],
      ).status,
      "pending",
    );
    await assert.rejects(
      () =>
        f.request(`/mcp/${publicServer.id}/tools/call`, "POST", {
          name: "issues.read",
          arguments: { issue: 42 },
        }),
      /explicitly connected/,
    );
    await assert.rejects(
      () =>
        f.request(`/mcp/${publicServer.id}/tools/call`, "POST", {
          name: "not-in-registry",
          arguments: {},
          workspace: scopedWorkspace,
        }),
      /discovered registry/,
    );
  } finally {
    await f.app.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("local stdio MCP servers use an isolated process for discovery and tool calls", async () => {
  const program = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "roster-local-mcp-")),
    "server.mjs",
  );
  fs.writeFileSync(
    program,
    `import readline from "node:readline";
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (!request.id) return;
  const result = request.method === "initialize"
    ? { protocolVersion: "2025-11-25", serverInfo: { name: "Fixture stdio MCP" }, capabilities: { tools: {} } }
    : request.method === "tools/list"
      ? { tools: [{ name: "notes.read", description: "Read a note", inputSchema: { type: "object" } }] }
      : request.method === "tools/call"
        ? { content: [{ type: "text", text: "Local note: " + request.params.arguments.slug }] }
        : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});


`,
  );
  const f = await fixture(async () => ({ text: "unused" }));
  try {
    const connection = await f.request("/mcp/discover-local", "POST", {
      command: process.execPath,
      args: [program],
    });
    assert.equal(connection.transport, "stdio");
    assert.equal(connection.serverName, "Fixture stdio MCP");
    const call = await f.request(`/mcp/${connection.id}/tools/call`, "POST", {
      name: "notes.read",
      arguments: { slug: "launch" },
    });
    assert.equal(call.result.content[0].text, "Local note: launch");
  } finally {
    await f.app.close();
  }
});

test("protected MCP servers connect with PKCE and keep OAuth tokens out of SQLite", async () => {
  let tokenRequest;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body =
      req.headers["content-type"]?.includes("application/json") && raw
        ? JSON.parse(raw)
        : {};
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    if (req.url === "/secure" && req.method === "POST") {
      if (
        [
          "Bearer fixture-access-token",
          "Bearer fixture-refreshed-token",
        ].includes(req.headers.authorization)
      ) {
        if (body.method === "initialize") {
          res.setHeader("Content-Type", "application/json");
          return res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2025-11-25",
                serverInfo: { name: "Protected fixture" },
                capabilities: { tools: {} },
              },
            }),
          );
        }
        if (body.method === "tools/list") {
          res.setHeader("Content-Type", "application/json");
          return res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                tools: [
                  {
                    name: "secure.read",
                    description: "Read protected context",
                    inputSchema: { type: "object" },
                  },
                ],
              },
            }),
          );
        }
        if (body.method === "tools/call") {
          assert.equal(body.params.name, "secure.read");
          res.setHeader("Content-Type", "application/json");
          return res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                content: [{ type: "text", text: "Protected context" }],
              },
            }),
          );
        }
      }
      res.writeHead(401, {
        "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/secure"`,
      });
      return res.end();
    }
    if (req.url === "/.well-known/oauth-protected-resource/secure") {
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          resource: `${origin}/secure`,
          authorization_servers: [`${origin}/issuer`],
          scopes_supported: ["secure.read"],
        }),
      );
    }
    if (req.url === "/issuer/.well-known/oauth-authorization-server") {
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          issuer: `${origin}/issuer`,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          code_challenge_methods_supported: ["S256"],
        }),
      );
    }
    if (req.url === "/register" && req.method === "POST") {
      assert.deepEqual(body.redirect_uris.length, 1);
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ client_id: "fixture-client" }));
    }
    if (req.url === "/token" && req.method === "POST") {
      tokenRequest = new URLSearchParams(raw);
      assert.equal(tokenRequest.get("client_id"), "fixture-client");
      assert.equal(tokenRequest.get("resource"), `${origin}/secure`);
      if (tokenRequest.get("grant_type") === "authorization_code") {
        assert.equal(tokenRequest.get("code"), "fixture-code");
        assert.ok(tokenRequest.get("code_verifier"));
      } else {
        assert.equal(tokenRequest.get("grant_type"), "refresh_token");
        assert.equal(
          tokenRequest.get("refresh_token"),
          "fixture-refresh-token",
        );
      }
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          access_token:
            tokenRequest.get("grant_type") === "refresh_token"
              ? "fixture-refreshed-token"
              : "fixture-access-token",
          refresh_token: "fixture-refresh-token",
          expires_in:
            tokenRequest.get("grant_type") === "refresh_token" ? 300 : 0,
        }),
      );
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const f = await fixture(async () => ({ text: "unused" }));
  try {
    const port = server.address().port;
    const connection = await f.request("/mcp/discover", "POST", {
      url: `http://127.0.0.1:${port}/secure`,
    });
    const authorization = await f.request(
      `/mcp/${connection.id}/authorize`,
      "POST",
      {},
    );
    const authorizeUrl = new URL(authorization.authorizationUrl);
    assert.equal(
      authorizeUrl.searchParams.get("code_challenge_method"),
      "S256",
    );
    assert.equal(
      authorizeUrl.searchParams.get("resource"),
      `http://127.0.0.1:${port}/secure`,
    );
    assert.equal(authorizeUrl.searchParams.get("scope"), null);
    const callback = new URL(authorizeUrl.searchParams.get("redirect_uri"));
    callback.searchParams.set("code", "fixture-code");
    callback.searchParams.set("state", authorizeUrl.searchParams.get("state"));
    const callbackResponse = await fetch(callback);
    assert.equal(callbackResponse.status, 200);
    assert.match(await callbackResponse.text(), /Connected/);
    assert.ok(tokenRequest);
    const state = await f.request("/state");
    assert.equal(state.mcpConnections[0].status, "available");
    const call = await f.request(`/mcp/${connection.id}/tools/call`, "POST", {
      name: "secure.read",
      arguments: {},
    });
    assert.equal(call.result.content[0].text, "Protected context");
    assert.equal(tokenRequest.get("grant_type"), "refresh_token");
    const serialized = JSON.stringify(
      f.app.store.one(
        "SELECT auth_metadata_json FROM mcp_connections WHERE id=?",
        [connection.id],
      ),
    );
    assert.ok(!serialized.includes("fixture-access-token"));
    assert.ok(!serialized.includes("fixture-refresh-token"));
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
  fs.mkdirSync(path.join(workspace, ".agents", "skills"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, ".agents", "skills", "release.md"),
    "Do not execute this during discovery.",
  );
  fs.writeFileSync(path.join(workspace, ".mcp.json"), "{}");
  const f = await fixture(async () => ({ text: "unused" }));
  try {
    const project = await f.request("/projects/inspect", "POST", { workspace });
    assert.equal(project.name, "sample");
    assert.equal(project.instructions[0].name, "AGENTS.md");
    assert.equal(project.scripts.length, 2);
    assert.deepEqual(project.environment.setup, ["npm ci"]);
    assert.equal(project.environment.testCommand, "npm run test");
    assert.equal(project.environment.buildCommand, "npm run build");
    assert.equal(
      project.resources.some(
        (resource) =>
          resource.type === "skill" &&
          resource.path === ".agents/skills/release.md",
      ),
      true,
    );
    assert.equal(
      project.resources.some(
        (resource) => resource.type === "mcp_configuration",
      ),
      true,
    );
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
    JSON.stringify({
      name: "profiled-app",
      scripts: { dev: "vite", test: "node --test" },
    }),
  );
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "Run the focused test.");
  let prompt = "";
  const f = await fixture(async (options) => {
    prompt = options.prompt;
    return { text: "Completed the requested work." };
  });
  try {
    fs.writeFileSync(path.join(workspace, "package-lock.json"), "{}");
    fs.writeFileSync(path.join(workspace, ".env.local"), "LOCAL_ONLY=true\n");
    const profile = await f.request("/projects/profile", "POST", { workspace });
    assert.equal(profile.name, "profiled-app");
    assert.deepEqual(profile.environment.setup, ["npm ci"]);
    const updated = await f.request("/projects/environment", "PUT", {
      workspace,
      setup: ["npm ci"],
      filesToCopy: [".env.local"],
      devCommand: "npm run dev",
      testCommand: "npm run test",
      buildCommand: "npm run build",
    });
    assert.deepEqual(updated.filesToCopy, [".env.local"]);
    assert.equal(
      (
        await f.request(
          `/projects/environment?workspace=${encodeURIComponent(workspace)}`,
        )
      ).buildCommand,
      "npm run build",
    );
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
    assert.match(prompt, /Project environment/);
    assert.match(prompt, /Discovered project resources/);
    assert.match(prompt, /npm run build/);
    assert.match(prompt, /ROSTER_PORT=4\d{3}/);
    assert.match(
      f.app.store.one("SELECT preview_url FROM tasks ORDER BY rowid DESC")
        .preview_url,
      /^http:\/\/127\.0\.0\.1:4\d{3}$/,
    );
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
    await f.request(`/messages/${sent.id}/reactions`, "POST", { emoji: "ðŸ‘" });
    let messages = await f.request(
      `/conversations/${a.conversationId}/messages`,
    );
    assert.deepEqual(
      messages.find((message) => message.id === sent.id).reactions,
      ["ðŸ‘"],
    );
    await f.request(`/messages/${sent.id}/reactions`, "POST", { emoji: "ðŸ‘" });
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
    const receipt = await fetch(`${f.app.url}/api/digest/weekly/receipt`);
    assert.equal(receipt.status, 200);
    assert.match(await receipt.text(), /Verified task/);
    assert.match(
      receipt.headers.get("content-disposition"),
      /Roster-weekly-receipt/,
    );
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

test("independent review criteria cannot be self-recorded", async () => {
  const f = await fixture(async () => ({ text: "response" }));
  try {
    const a = await f.request("/agents", "POST", worker("Alex"));
    await f.request(`/conversations/${a.conversationId}/messages`, "POST", {
      content: "Fix the sample issue.",
    });
    const task = await until(() =>
      f.app.store.one("SELECT * FROM tasks WHERE status='completed'"),
    );
    const review = f.app.store.one(
      "SELECT c.* FROM acceptance_criteria c JOIN outcome_contracts o ON o.id=c.outcome_id WHERE o.task_id=? AND c.type='review'",
      [task.id],
    );
    await assert.rejects(
      () =>
        f.request(`/criteria/${review.id}/record`, "POST", {
          status: "pass",
          evidence: "This must not substitute for an independent review.",
        }),
      /Independent review criteria/,
    );
    assert.equal(
      f.app.store.one("SELECT status FROM acceptance_criteria WHERE id=?", [
        review.id,
      ]).status,
      "pending",
    );
  } finally {
    await f.app.close();
  }
});

test("detected browser scripts create bounded verification evidence", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "roster-browser-"));
  fs.writeFileSync(
    path.join(workspace, "package.json"),
    JSON.stringify({ scripts: { "test:e2e": "node browser-check.mjs" } }),
  );
  fs.writeFileSync(
    path.join(workspace, "browser-check.mjs"),
    'console.log("browser flow passed")',
  );
  const f = await fixture(async () => ({ text: "response" }));
  try {
    const a = await f.request("/agents", "POST", worker("Alex", { workspace }));
    await f.request(`/conversations/${a.conversationId}/messages`, "POST", {
      content: "Fix the sample issue.",
    });
    const task = await until(() =>
      f.app.store.one("SELECT * FROM tasks WHERE status='completed'"),
    );
    const checks = await f.request(`/tasks/${task.id}/browser-checks`);
    assert.deepEqual(
      checks.scripts.map((item) => item.name),
      ["test:e2e"],
    );
    const run = await f.request(`/tasks/${task.id}/browser-check`, "POST", {
      script: "test:e2e",
    });
    assert.match(run.output, /browser flow passed/);
    assert.equal(
      f.app.store.one(
        "SELECT c.status FROM acceptance_criteria c JOIN outcome_contracts o ON o.id=c.outcome_id WHERE o.task_id=? AND c.type='browser'",
        [task.id],
      ).status,
      "pass",
    );
    assert.match(
      f.app.store.one(
        "SELECT summary FROM evidence WHERE task_id=? AND type='browser'",
        [task.id],
      ).summary,
      /completed successfully/,
    );
    assert.match(
      f.app.store.one(
        "SELECT content FROM artifacts WHERE task_id=? AND name=?",
        [task.id, "test:e2e browser verification.txt"],
      ).content,
      /browser flow passed/,
    );
  } finally {
    await f.app.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("a late acceptance criterion refreshes and then restores the work receipt", async () => {
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
    f.app.store.transaction(() => {
      f.app.store.run(
        "UPDATE acceptance_criteria SET status='pass' WHERE outcome_id=?",
        [outcome.id],
      );
      f.app.store.run(
        "UPDATE outcome_contracts SET status='satisfied' WHERE id=?",
        [outcome.id],
      );
      f.app.store.run("UPDATE tasks SET verification='verified' WHERE id=?", [
        task.id,
      ]);
      f.app.store.run(
        "INSERT INTO work_receipts(id,task_id,outcome_id,content,created_at) VALUES(?,?,?,?,?)",
        [
          "00000000-0000-4000-8000-000000000301",
          task.id,
          outcome.id,
          "old",
          new Date().toISOString(),
        ],
      );
    });
    await f.request(`/outcomes/${outcome.id}/criteria`, "POST", {
      type: "test",
      description: "The focused regression passes",
    });
    assert.equal(
      f.app.store.one("SELECT status FROM outcome_contracts WHERE id=?", [
        outcome.id,
      ]).status,
      "verifying",
    );
    assert.equal(
      f.app.store.one("SELECT id FROM work_receipts WHERE task_id=?", [
        task.id,
      ]),
      undefined,
    );
    const criterion = f.app.store.one(
      "SELECT * FROM acceptance_criteria WHERE outcome_id=? AND description=?",
      [outcome.id, "The focused regression passes"],
    );
    await f.request(`/criteria/${criterion.id}/record`, "POST", {
      status: "pass",
      evidence: "The focused regression passed successfully.",
    });
    assert.equal(
      f.app.store.one("SELECT status FROM outcome_contracts WHERE id=?", [
        outcome.id,
      ]).status,
      "satisfied",
    );
    assert.match(
      f.app.store.one("SELECT content FROM work_receipts WHERE task_id=?", [
        task.id,
      ]).content,
      /focused regression passed successfully/,
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
    const diskFile = fs.readdirSync(dir).find((name) => name.endsWith(".enc"));
    assert.ok(diskFile);
    assert.notEqual(diskFile, "web-provider-key.enc");
    const disk = fs.readFileSync(path.join(dir, diskFile), "utf8");
    assert.ok(!disk.includes("test-only-secret"));
    assert.equal(createVault(dir).get(), "test-only-secret-not-a-real-key");
    vault.set("");
    assert.equal(
      fs.readdirSync(dir).some((name) => name.endsWith(".enc")),
      false,
    );
    vault.setNamed("mcp:example", "token-for-one-server");
    vault.setNamed("mcp:other", "token-for-another-server");
    assert.equal(
      createVault(dir).getNamed("mcp:example"),
      "token-for-one-server",
    );
    assert.equal(
      createVault(dir).getNamed("mcp:other"),
      "token-for-another-server",
    );
    vault.setNamed("mcp:example", "");
    vault.setNamed("mcp:other", "");
  },
);
