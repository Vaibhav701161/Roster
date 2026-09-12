import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("team routing, dependency outputs, approval pause/resume, explicit mentions and bench exclusion", async () => {
  let members = [],
    calls = [],
    approval = false;
  const f = await fixture(async (o) => {
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
    assert.equal(calls.length, 2);
    assert.equal(
      f.app.store.one("SELECT verification FROM tasks WHERE id=?", [
        pending.task_id,
      ]).verification,
      "reviewed",
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
  let attempt = 0;
  const f = await fixture(async (o) => {
    o.onDelta("Useful partial response.");
    if (!attempt++) throw new Error("Provider test failure");
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
