import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { id, now } from "./store.mjs";
import {
  detectCodex,
  detectClaude,
  runCodex,
  runClaude,
  runCompatible,
  cleanError,
} from "./runtime.mjs";
import { routerSchema, routerPrompt, workerPrompt } from "./prompts.mjs";
import { buildContext } from "./context.mjs";
const assignment = z.object({
  agent_id: z.string(),
  objective: z.string().min(1).max(8000),
  depends_on: z.array(z.number().int().nonnegative()),
  kind: z.enum(["work", "review"]),
});
export function validatePlan(value, members) {
  const plan = z
    .object({
      type: z.enum(["chat", "task"]),
      assignments: z.array(assignment).min(1).max(6),
    })
    .parse(value);
  plan.assignments.forEach((a, i) => {
    if (
      !members.some((m) => m.id === a.agent_id) ||
      a.depends_on.some((d) => d >= i)
    )
      throw new Error(
        "The team plan contained an invalid worker or dependency.",
      );
  });
  return plan;
}
const terminal = ["completed", "failed", "cancelled", "interrupted"];
export function overlappingWorkspaces(a, b) {
  if (!a || !b) return false;
  const normalize = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const rel = path.relative(normalize(a), normalize(b)),
    reverse = path.relative(normalize(b), normalize(a));
  const inside = (p) =>
    !p || (!p.startsWith(".." + path.sep) && p !== ".." && !path.isAbsolute(p));
  return inside(rel) || inside(reverse);
}
export function createEngine(
  store,
  broadcast,
  {
    getKey = () => process.env.OPENAI_API_KEY,
    logDirectory = store.directory,
    runner,
  } = {},
) {
  const active = new Map(),
    approvals = new Map(),
    planning = new Map();
  let shuttingDown = false,
    health = [];
  const emit = () => broadcast("state.changed", {});
  const event = (taskId, type, detail) => {
    store.run("INSERT INTO events VALUES(?,?,?,?,?)", [
      id(),
      taskId,
      type,
      typeof detail === "string" ? detail : JSON.stringify(detail),
      now(),
    ]);
    const owner = store.one(
      "SELECT owner_id,conversation_id FROM tasks WHERE id=?",
      [taskId],
    );
    fs.mkdirSync(logDirectory, { recursive: true });
    fs.appendFileSync(
      path.join(logDirectory, "runtime.log"),
      JSON.stringify({
        timestamp: now(),
        level: type.includes("failed") ? "error" : "info",
        module: "runtime",
        taskId,
        agentId: owner?.owner_id,
        conversationId: owner?.conversation_id,
        event: type,
      }) + "\n",
    );
    emit();
  };
  const message = (
    conversationId,
    role,
    content,
    agentId = null,
    kind = "text",
    status = "complete",
    replyTo = null,
  ) => {
    const mid = id();
    store.run(
      "INSERT INTO messages(id,conversation_id,agent_id,role,content,kind,status,reply_to,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [
        mid,
        conversationId,
        agentId,
        role,
        content,
        kind,
        status,
        replyTo,
        now(),
      ],
    );
    store.run("UPDATE conversations SET updated_at=? WHERE id=?", [
      now(),
      conversationId,
    ]);
    emit();
    return mid;
  };
  async function detect() {
    const [codex, claude] = await Promise.all([detectCodex(), detectClaude()]);
    const claudeHealth =
      claude.status === "available" && store.setting("claudeVerified", false)
        ? {
            ...claude,
            status: "connected",
            detail: "Connected through the local Claude Code CLI.",
          }
        : claude;
    const cfg = store.setting("compatible");
    health = [
      codex,
      claudeHealth,
      {
        id: "compatible",
        name: cfg?.name || "OpenAI-compatible",
        status: cfg ? "configured" : "not_configured",
        detail:
          cfg?.endpoint ||
          "Connect OpenAI, Ollama, or another compatible service.",
      },
    ];
    emit();
    return health;
  }
  const chooseProvider = () => {
    if (health.find((x) => x.id === "codex")?.status === "connected")
      return "codex";
    if (health.find((x) => x.id === "claude")?.status === "connected")
      return "claude";
    if (store.setting("compatible")) return "compatible";
    throw new Error(
      "No AI runtime is connected. Your message is saved. Connect a runtime in Settings, then retry.",
    );
  };
  const choose = (agent) =>
    agent.provider !== "auto" ? agent.provider : chooseProvider();
  async function invokeProvider(provider, options) {
    if (runner) return runner(options);
    if (provider === "codex") return runCodex(options);
    if (provider === "claude") return runClaude(options);
    const config = store.setting("compatible");
    if (!config) throw new Error("Connect this worker’s runtime in Settings.");
    return runCompatible({ ...options, config, key: getKey() });
  }
  async function invoke(agent, options) {
    if (runner) return runner(options);
    return invokeProvider(choose(agent), options);
  }
  async function route(conversation, text, mid) {
    const controller = new AbortController();
    planning.set(conversation.id, controller);
    emit();
    try {
      const team = conversation.team_id
        ? store.one("SELECT * FROM teams WHERE id=?", [conversation.team_id])
        : null;
      const members = team
        ? store.all(
            "SELECT a.* FROM agents a JOIN team_members m ON a.id=m.agent_id WHERE m.team_id=? AND a.benched=0",
            [team.id],
          )
        : store.all("SELECT * FROM agents WHERE id=? AND benched=0", [
            conversation.agent_id,
          ]);
      if (!members.length)
        throw new Error(
          "There are no active workers in this chat. Add a worker or bring someone off the bench.",
        );
      const mentioned = members.filter((a) =>
        new RegExp(
          "@" +
            a.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
            "(?=\\s|[.,!?;:]|$)",
          "i",
        ).test(text),
      );
      let plan;
      if (!team || mentioned.length === 1) {
        const member = mentioned[0] || members[0];
        plan = {
          type: /\b(build|fix|research|inspect|implement|create|write|review|verify|analy[sz]e|test|prepare|update|find)\b/i.test(
            text,
          )
            ? "task"
            : "chat",
          assignments: [
            {
              agent_id: member.id,
              objective: text,
              depends_on: [],
              kind: "work",
            },
          ],
        };
      } else {
        const scratch = path.join(store.directory, "coordinator");
        fs.mkdirSync(scratch, { recursive: true });
        let lastError;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const result = await invokeProvider(
              runner ? "test" : chooseProvider(),
              {
                prompt:
                  routerPrompt(team, members, text) +
                  (attempt
                    ? "\nPrevious response was invalid. Return valid JSON following the schema."
                    : ""),
                cwd: scratch,
                readOnly: true,
                signal: controller.signal,
                outputSchema: routerSchema,
              },
            );
            plan = validatePlan(JSON.parse(result.text), members);
            break;
          } catch (e) {
            lastError = e;
            if (controller.signal.aborted) throw e;
          }
        }
        if (!plan)
          throw new Error(
            "The team could not make a valid assignment. Try an explicit @mention. " +
              cleanError(lastError),
          );
      }
      if (controller.signal.aborted) throw new Error("Cancelled");
      const ids = plan.assignments.map(() => id());
      store.transaction(() =>
        plan.assignments.forEach((a, i) => {
          const worker = members.find((m) => m.id === a.agent_id);
          const workspace = team?.workspace || worker.workspace;
          store.run(
            "INSERT INTO tasks(id,conversation_id,message_id,owner_id,title,objective,status,kind,workspace,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            [
              ids[i],
              conversation.id,
              mid,
              a.agent_id,
              a.objective.slice(0, 100),
              a.objective,
              a.depends_on.length ? "waiting_dependency" : "queued",
              plan.type === "chat" ? "chat" : a.kind,
              workspace,
              now(),
            ],
          );
          a.depends_on.forEach((d) =>
            store.run("INSERT INTO task_dependencies VALUES(?,?)", [
              ids[i],
              ids[d],
            ]),
          );
          event(
            ids[i],
            "task.created",
            a.depends_on.length
              ? `${worker.name} will continue after earlier work finishes.`
              : `Assigned to ${worker.name}.`,
          );
        }),
      );
    } catch (e) {
      message(
        conversation.id,
        "system",
        controller.signal.aborted
          ? "Request cancelled. Your message is preserved."
          : cleanError(e),
        null,
        "error",
      );
    } finally {
      planning.delete(conversation.id);
      emit();
      schedule();
    }
  }
  function schedule() {
    if (shuttingDown) return;
    const waiting = store.all(
      "SELECT * FROM tasks WHERE status IN ('queued','waiting_dependency') ORDER BY created_at",
    );
    for (const task of waiting) {
      if (active.size >= store.setting("parallelLimit", 2)) break;
      const deps = store.all(
        "SELECT t.* FROM tasks t JOIN task_dependencies d ON t.id=d.depends_on WHERE d.task_id=?",
        [task.id],
      );
      if (deps.some((d) => ["failed", "cancelled"].includes(d.status))) {
        store.run(
          "UPDATE tasks SET status='failed',error='Earlier work did not finish. Retry it before continuing.',completed_at=? WHERE id=?",
          [now(), task.id],
        );
        event(task.id, "task.blocked", "Dependency failed or was cancelled.");
        continue;
      }
      if (deps.some((d) => d.status !== "completed")) continue;
      const worker = store.one("SELECT * FROM agents WHERE id=?", [
        task.owner_id,
      ]);
      if (!worker || worker.benched) {
        store.run(
          "UPDATE tasks SET status='failed',error='This worker is unavailable.',completed_at=? WHERE id=?",
          [now(), task.id],
        );
        emit();
        continue;
      }
      if (
        [...active.values()].some(
          (r) =>
            r.owner === task.owner_id ||
            overlappingWorkspaces(r.workspace, task.workspace),
        )
      )
        continue;
      const controller = new AbortController();
      active.set(task.id, {
        controller,
        owner: task.owner_id,
        workspace: task.workspace,
      });
      execute(task, worker, controller).catch((e) =>
        event(task.id, "runtime.error", cleanError(e)),
      );
    }
  }
  async function execute(task, agent, controller) {
    store.run("UPDATE tasks SET status='running',started_at=? WHERE id=?", [
      now(),
      task.id,
    ]);
    event(
      task.id,
      "task.started",
      `${agent.name} started ${task.kind === "chat" ? "responding" : "working"}.`,
    );
    const mid = message(
      task.conversation_id,
      "assistant",
      "",
      agent.id,
      "text",
      "streaming",
    );
    let response = "",
      lastFlush = 0;
    let updateTimer;
    const updateUI = () => {
      updateTimer = undefined;
      broadcast("message.delta", { id: mid, content: response });
    };
    try {
      const workspace =
        task.workspace || path.join(store.directory, "workspaces", agent.id);
      fs.mkdirSync(workspace, { recursive: true });
      const history = await buildContext(
        store,
        task.conversation_id,
        (prompt) =>
          invoke(agent, {
            prompt,
            cwd: workspace,
            readOnly: true,
            signal: controller.signal,
          }),
        (type, detail) => event(task.id, type, detail),
      );
      const conv = store.one("SELECT * FROM conversations WHERE id=?", [
        task.conversation_id,
      ]);
      const team = conv.team_id
        ? store.one("SELECT * FROM teams WHERE id=?", [conv.team_id])
        : null;
      const memory = store.all(
        "SELECT content FROM memories WHERE scope_id IN (?,?)",
        [agent.id, team?.id || ""],
      );
      const deps = store.all(
        "SELECT t.id,t.title,t.result FROM tasks t JOIN task_dependencies d ON t.id=d.depends_on WHERE d.task_id=?",
        [task.id],
      );
      const instructions = store.all(
        "SELECT message_id,kind,content,created_at FROM task_instructions WHERE task_id=? ORDER BY created_at",
        [task.id],
      );
      const attachmentMessageIds = [
        task.message_id,
        ...instructions.map((item) => item.message_id),
      ].filter(Boolean);
      const attachments = store.all(
        `SELECT name,content FROM attachments WHERE message_id IN (${attachmentMessageIds.map(() => "?").join(",")})`,
        attachmentMessageIds,
      );
      const provider = runner ? "test" : choose(agent);
      const session =
        task.kind === "chat"
          ? store.one(
              "SELECT thread_id FROM runtime_sessions WHERE agent_id=? AND conversation_id=? AND provider=? AND workspace=?",
              [agent.id, task.conversation_id, provider, workspace],
            )
          : null;
      const result = await invoke(agent, {
        prompt: workerPrompt(
          agent,
          instructions.length
            ? {
                ...task,
                objective: `${task.objective}\n\nLatest user instructions:\n${instructions.map((item) => `- ${item.content}`).join("\n")}`,
              }
            : task,
          history,
          memory,
          deps,
          attachments,
          team,
        ),
        cwd: workspace,
        threadId: session?.thread_id,
        signal: controller.signal,
        onSession: (threadId) =>
          store.run(
            "INSERT INTO runtime_sessions(id,agent_id,conversation_id,provider,thread_id,workspace,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(agent_id,conversation_id,provider,workspace) DO UPDATE SET thread_id=excluded.thread_id,updated_at=excluded.updated_at",
            [
              id(),
              agent.id,
              task.conversation_id,
              provider,
              threadId,
              workspace,
              now(),
            ],
          ),
        onDelta: (delta) => {
          response += delta;
          if (!updateTimer) updateTimer = setTimeout(updateUI, 50);
          if (Date.now() - lastFlush > 700) {
            store.run("UPDATE messages SET content=? WHERE id=?", [
              response,
              mid,
            ]);
            lastFlush = Date.now();
          }
        },
        onEvent: (e) => event(task.id, e.type, e),
        onApproval: (request) =>
          new Promise((resolve) => {
            const aid = id();
            store.run(
              "INSERT INTO approvals(id,task_id,title,detail,created_at) VALUES(?,?,?,?,?)",
              [aid, task.id, request.title, request.detail, now()],
            );
            store.run("UPDATE tasks SET status='waiting_approval' WHERE id=?", [
              task.id,
            ]);
            approvals.set(aid, { resolve, taskId: task.id });
            event(task.id, "approval.requested", request.title);
          }),
      });
      if (controller.signal.aborted) throw new Error("Cancelled");
      response = result.text || response;
      if (!response)
        throw new Error(
          "The worker returned no response. Your message is preserved.",
        );
      store.run("UPDATE messages SET content=?,status='complete' WHERE id=?", [
        response,
        mid,
      ]);
      store.run(
        "UPDATE tasks SET status='completed',result=?,completed_at=?,verification=? WHERE id=?",
        [
          response,
          now(),
          task.kind === "review" ? "reviewed" : "unverified",
          task.id,
        ],
      );
      if (task.kind === "review")
        for (const dep of deps)
          store.run("UPDATE tasks SET verification='reviewed' WHERE id=?", [
            dep.id,
          ]);
      if (task.kind !== "chat") {
        const filename =
          task.title
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
            .slice(0, 70)
            .trim() || "Work result";
        store.run("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)", [
          id(),
          task.id,
          task.conversation_id,
          filename + ".md",
          response,
          Buffer.byteLength(response),
          now(),
        ]);
        event(task.id, "artifact.created", "Saved the work result in Files.");
      }
      event(
        task.id,
        "task.completed",
        task.kind === "review"
          ? "Independent review completed. See the review for evidence and limitations."
          : "Worker completed.",
      );
      if (result.usage) event(task.id, "usage.recorded", result.usage);
    } catch (e) {
      const redirected =
        controller.signal.aborted &&
        store.one("SELECT status FROM tasks WHERE id=?", [task.id])?.status ===
          "queued";
      const interrupted =
        controller.signal.aborted &&
        store.one("SELECT status FROM tasks WHERE id=?", [task.id])?.status ===
          "interrupted";
      const cancelled =
        controller.signal.aborted && !redirected && !interrupted;
      if (redirected || interrupted) {
        store.run(
          "UPDATE messages SET content=?,status='interrupted' WHERE id=?",
          [
            response ||
              (interrupted
                ? "Roster closed while work was running. Resume to continue."
                : "Work paused to apply your latest instruction."),
            mid,
          ],
        );
        event(
          task.id,
          interrupted ? "task.interrupted" : "task.steered",
          interrupted
            ? "Roster closed. Work can be resumed."
            : "Restarting with your latest instruction.",
        );
        return;
      }
      const error = cancelled
        ? "Cancelled. Completed work was preserved."
        : cleanError(e);
      store.run("UPDATE messages SET content=?,status=? WHERE id=?", [
        response || error,
        cancelled ? "cancelled" : "error",
        mid,
      ]);
      store.run("UPDATE tasks SET status=?,error=?,completed_at=? WHERE id=?", [
        cancelled ? "cancelled" : "failed",
        error,
        now(),
        task.id,
      ]);
      event(task.id, cancelled ? "task.cancelled" : "task.failed", error);
    } finally {
      clearTimeout(updateTimer);
      for (const [aid, p] of approvals)
        if (p.taskId === task.id) {
          p.resolve(false);
          approvals.delete(aid);
          store.run(
            "UPDATE approvals SET status='expired',resolved_at=? WHERE id=?",
            [now(), aid],
          );
        }
      active.delete(task.id);
      emit();
      schedule();
    }
  }
  function resolveApproval(aid, allow) {
    const approval = approvals.get(aid);
    if (!approval)
      throw new Error(
        "This approval is no longer active. Retry the task if needed.",
      );
    store.run("UPDATE approvals SET status=?,resolved_at=? WHERE id=?", [
      allow ? "approved" : "rejected",
      now(),
      aid,
    ]);
    store.run("UPDATE tasks SET status='running' WHERE id=?", [
      approval.taskId,
    ]);
    approval.resolve(allow);
    approvals.delete(aid);
    event(
      approval.taskId,
      "approval.resolved",
      allow ? "Approved by you." : "Declined by you.",
    );
  }
  function cancel(taskId) {
    const task = store.one("SELECT * FROM tasks WHERE id=?", [taskId]);
    if (!task || terminal.includes(task.status)) return;
    active.get(taskId)?.controller.abort();
    store.run("UPDATE tasks SET status='cancelled',completed_at=? WHERE id=?", [
      now(),
      taskId,
    ]);
    for (const [aid, p] of approvals)
      if (p.taskId === taskId) {
        p.resolve(false);
        approvals.delete(aid);
        store.run(
          "UPDATE approvals SET status='expired',resolved_at=? WHERE id=?",
          [now(), aid],
        );
      }
    for (const child of store.all(
      "SELECT task_id FROM task_dependencies WHERE depends_on=?",
      [taskId],
    ))
      cancel(child.task_id);
    emit();
  }
  function retry(taskId) {
    const t = store.one("SELECT * FROM tasks WHERE id=?", [taskId]);
    if (!t || !["failed", "cancelled", "interrupted"].includes(t.status))
      throw new Error(
        "Only interrupted, failed, or cancelled work can be resumed.",
      );
    store.run(
      "UPDATE tasks SET status='queued',error='',completed_at=NULL WHERE id=?",
      [taskId],
    );
    event(taskId, "task.retried", "Retry requested by you.");
    schedule();
  }
  function steer(conversationId, messageId, content) {
    const task = store.one(
      "SELECT * FROM tasks WHERE conversation_id=? AND status IN ('running','waiting_approval','queued','waiting_dependency') ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'waiting_approval' THEN 1 ELSE 2 END,created_at LIMIT 1",
      [conversationId],
    );
    if (!task) return false;
    const followUp =
      /\b(after (this|that|it)|when (this|that|it) (is )?done|once (this|that|it) (is )?done|follow(?:\s|-)?up)\b/i.test(
        content,
      );
    if (followUp) {
      const followUpId = id();
      store.transaction(() => {
        store.run(
          "INSERT INTO tasks(id,conversation_id,message_id,owner_id,title,objective,status,kind,workspace,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
          [
            followUpId,
            conversationId,
            messageId,
            task.owner_id,
            content.slice(0, 100),
            content,
            "waiting_dependency",
            "work",
            task.workspace,
            now(),
          ],
        );
        store.run("INSERT INTO task_dependencies VALUES(?,?)", [
          followUpId,
          task.id,
        ]);
      });
      event(followUpId, "task.queued", "Queued after the current work.");
      emit();
      return "queued";
    }
    store.run("INSERT INTO task_instructions VALUES(?,?,?,?,?,?)", [
      id(),
      task.id,
      messageId,
      "steering",
      content,
      now(),
    ]);
    event(
      task.id,
      "task.instruction_added",
      "Added your latest instruction to this work.",
    );
    if (["running", "waiting_approval"].includes(task.status)) {
      store.run("UPDATE tasks SET status='queued',error='' WHERE id=?", [
        task.id,
      ]);
      active.get(task.id)?.controller.abort();
      for (const [aid, pending] of approvals)
        if (pending.taskId === task.id) {
          pending.resolve(false);
          approvals.delete(aid);
          store.run(
            "UPDATE approvals SET status='expired',resolved_at=? WHERE id=?",
            [now(), aid],
          );
        }
      event(
        task.id,
        "task.restart_requested",
        "Pausing safely to apply your latest instruction.",
      );
    }
    emit();
    return "steered";
  }
  store.run(
    "UPDATE tasks SET status='interrupted',error='Roster was closed while this work was running. Saved progress and instructions are preserved; resume to continue.',completed_at=? WHERE status IN ('running','waiting_approval')",
    [now()],
  );
  store.run(
    "UPDATE messages SET status='interrupted' WHERE status='streaming'",
  );
  store.run(
    "UPDATE approvals SET status='expired',resolved_at=? WHERE status='pending'",
    [now()],
  );
  schedule();
  return {
    detect,
    get health() {
      return health;
    },
    message,
    route,
    cancel,
    retry,
    steer,
    resolveApproval,
    event,
    planning,
    active,
    stopConversation(cid) {
      planning.get(cid)?.abort();
      for (const t of store.all(
        "SELECT id FROM tasks WHERE conversation_id=? AND status NOT IN ('completed','failed','cancelled')",
        [cid],
      ))
        cancel(t.id);
    },
    async close() {
      shuttingDown = true;
      for (const c of planning.values()) c.abort();
      const closedAt = now();
      for (const [taskId, run] of active) {
        store.run(
          "UPDATE tasks SET status='interrupted',error='Roster was closed while this work was running. Saved progress and instructions are preserved; resume to continue.',completed_at=? WHERE id=?",
          [closedAt, taskId],
        );
        run.controller.abort();
      }
      for (const [aid, pending] of approvals) {
        pending.resolve(false);
        approvals.delete(aid);
        store.run(
          "UPDATE approvals SET status='expired',resolved_at=? WHERE id=?",
          [closedAt, aid],
        );
      }
      for (let i = 0; i < 100 && (active.size || planning.size); i++)
        await new Promise((r) => setTimeout(r, 50));
    },
  };
}
