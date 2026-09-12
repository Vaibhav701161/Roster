import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
const exec = promisify(execFile);
const require = createRequire(import.meta.url);
export function codexCommand() {
  if (process.env.ROSTER_CODEX_BIN)
    return { command: process.env.ROSTER_CODEX_BIN, args: [] };
  try {
    const platform = process.platform;
    const pkg = path.dirname(
      require.resolve(`@openai/codex-${platform}-${process.arch}/package.json`),
    );
    const triple =
      process.platform === "win32"
        ? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc`
        : process.platform === "darwin"
          ? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
          : `${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl`;
    return {
      command: path
        .join(
          pkg,
          "vendor",
          triple,
          "bin",
          process.platform === "win32" ? "codex.exe" : "codex",
        )
        .replace("app.asar", "app.asar.unpacked"),
      args: [],
    };
  } catch {
    return { command: "codex", args: [] };
  }
}
export function claudeCommand() {
  if (process.env.ROSTER_CLAUDE_BIN)
    return { command: process.env.ROSTER_CLAUDE_BIN, args: [] };
  const candidates =
    process.platform === "darwin"
      ? [
          path.join(os.homedir(), ".local", "bin", "claude"),
          "/opt/homebrew/bin/claude",
          "/usr/local/bin/claude",
          "/usr/bin/claude",
        ]
      : [];
  const installed = candidates.find((candidate) => {
    try {
      const stat = fs.statSync(candidate);
      return stat.isFile() && (stat.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  });
  return { command: installed || "claude", args: [] };
}
export const cleanError = (error) =>
  String(error?.message || error)
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 1200);
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => child.kill());
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
      const force = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The owned process group exited cleanly.
        }
      }, 5000);
      force.unref();
    } catch {
      child.kill("SIGTERM");
    }
  }
}
export async function detectCodex() {
  const c = codexCommand();
  try {
    const version = await exec(c.command, [...c.args, "--version"], {
      windowsHide: true,
      timeout: 12000,
    });
    try {
      const auth = await exec(c.command, [...c.args, "login", "status"], {
        windowsHide: true,
        timeout: 12000,
      });
      return {
        id: "codex",
        name: "Codex",
        status: /logged in/i.test(auth.stdout + auth.stderr)
          ? "connected"
          : "authentication_required",
        version: version.stdout.trim(),
      };
    } catch {
      return {
        id: "codex",
        name: "Codex",
        status: "authentication_required",
        version: version.stdout.trim(),
      };
    }
  } catch {
    return {
      id: "codex",
      name: "Codex",
      status: "unavailable",
      detail:
        "Native Codex could not start. Reinstall dependencies or set ROSTER_CODEX_BIN.",
    };
  }
}

// Claude Code has an officially supported print mode with newline-delimited
// stream-json output. Detection only checks the local executable; login is
// verified by the explicit provider Test action so startup never spends usage.
export async function detectClaude() {
  const c = claudeCommand();
  try {
    const version = await exec(c.command, [...c.args, "--version"], {
      windowsHide: true,
      timeout: 12000,
    });
    return {
      id: "claude",
      name: "Claude Code",
      status: "available",
      version: version.stdout.trim(),
      detail:
        "Installed. Use Test to verify your existing Claude Code sign-in.",
    };
  } catch {
    return {
      id: "claude",
      name: "Claude Code",
      status: "unavailable",
      detail: "Claude Code is not installed or is not on PATH.",
    };
  }
}

export async function runClaude({
  prompt,
  cwd,
  threadId,
  signal,
  onDelta = () => {},
  onEvent = () => {},
  onSession = () => {},
  readOnly = false,
}) {
  const c = claudeCommand();
  const args = [
    ...c.args,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    readOnly ? "8" : "24",
    ...(readOnly ? ["--permission-mode", "plan"] : []),
    ...(threadId ? ["--resume", threadId] : []),
  ];
  const child = spawn(c.command, args, {
    cwd,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (child.pid)
    onEvent({
      type: "runtime.started",
      detail: "Claude Code runtime started.",
      pid: child.pid,
      provider: "claude",
    });
  let text = "",
    sessionId = threadId,
    finished = false,
    lastStderr = "";
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});
  const finish = (error, result = {}) => {
    if (finished) return;
    finished = true;
    error
      ? rejectDone(error)
      : resolveDone({
          text: text || result.result || "",
          threadId: sessionId,
          usage: result.usage,
        });
  };
  child.stderr.on("data", (data) => {
    lastStderr = (lastStderr + data.toString()).slice(-3000);
  });
  child.on("error", finish);
  child.on("exit", (code) => {
    if (!finished)
      finish(
        new Error(
          `Claude Code exited (${code ?? "stopped"}). ${cleanError(lastStderr)}`,
        ),
      );
  });
  const lines = readline.createInterface({ input: child.stdout });
  const actions = new Set();
  const addText = (next) => {
    if (!next || next === text) return;
    const delta = next.startsWith(text) ? next.slice(text.length) : next;
    text = next.startsWith(text) ? next : text + (text ? "\n\n" : "") + next;
    onDelta(delta);
  };
  lines.on("line", (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.session_id && event.session_id !== sessionId) {
      sessionId = event.session_id;
      onSession(sessionId);
    }
    if (event.type === "assistant") {
      const blocks = event.message?.content || [];
      for (const block of blocks) {
        if (block.type === "text") addText(block.text || "");
        if (block.type === "tool_use") {
          const actionId = block.id || `${block.name}:${actions.size}`;
          if (!actions.has(actionId)) {
            actions.add(actionId);
            onEvent({
              type: "action.started",
              detail: block.name || "Claude Code tool",
              itemType: "tool",
            });
          }
        }
      }
    }
    if (event.type === "user") {
      const blocks = event.message?.content || [];
      if (blocks.some((block) => block.type === "tool_result"))
        onEvent({
          type: "action.completed",
          detail: "Claude Code completed a tool action.",
          itemType: "tool",
        });
    }
    if (event.type === "result") {
      addText(event.result || "");
      if (event.is_error || event.subtype === "error")
        finish(
          new Error(
            event.result || "Claude Code could not complete this request.",
          ),
        );
      else
        finish(null, {
          result: event.result,
          usage: {
            costUsd: event.total_cost_usd,
            durationMs: event.duration_ms,
            turns: event.num_turns,
          },
        });
    }
  });
  const abort = () => {
    finish(new Error("Cancelled"));
    killTree(child);
  };
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () => {
      finish(
        new Error(
          "This run reached its 15 minute limit. Your conversation is preserved.",
        ),
      );
      killTree(child);
    },
    15 * 60 * 1000,
  );
  try {
    if (signal?.aborted) throw new Error("Cancelled");
    child.stdin.write(prompt);
    child.stdin.end();
    return await done;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    lines.close();
    killTree(child);
  }
}

// Stable JSON-RPC app-server protocol: transport owns process; application owns tasks.
export async function runCodex({
  prompt,
  cwd,
  threadId,
  signal,
  onDelta = () => {},
  onEvent = () => {},
  onApproval,
  outputSchema,
  readOnly = false,
  onSession = () => {},
}) {
  const c = codexCommand();
  const child = spawn(c.command, [...c.args, "app-server"], {
    cwd,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (child.pid)
    onEvent({
      type: "runtime.started",
      detail: "Codex runtime started.",
      pid: child.pid,
      provider: "codex",
    });
  let serial = 0,
    finished = false,
    thread,
    turn,
    text = "",
    usage = null;
  const pending = new Map();
  const items = new Map();
  let lastMessageItem;
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});
  const send = (message) => {
    if (!child.stdin.destroyed)
      child.stdin.write(JSON.stringify(message) + "\n");
  };
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const n = ++serial;
      const timer = setTimeout(() => {
        pending.delete(n);
        reject(new Error(`${method} timed out`));
      }, 45000);
      pending.set(n, { resolve, reject, timer });
      send({ id: n, method, params });
    });
  const finish = (error) => {
    if (finished) return;
    finished = true;
    error ? rejectDone(error) : resolveDone({ text, threadId: thread, usage });
  };
  let lastStderr = "";
  child.stderr.on("data", (d) => {
    lastStderr = (lastStderr + d.toString()).slice(-3000);
  });
  child.on("error", finish);
  child.on("exit", (code) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Codex process ended"));
    }
    pending.clear();
    if (!finished)
      finish(
        new Error(
          `Codex exited (${code ?? "stopped"}). ${cleanError(lastStderr)}`,
        ),
      );
  });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && !msg.method) {
      const p = pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.id);
        msg.error
          ? p.reject(new Error(msg.error.message))
          : p.resolve(msg.result);
      }
      return;
    }
    const p = msg.params || {};
    if (msg.id !== undefined && msg.method) {
      if (
        [
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
        ].includes(msg.method) &&
        onApproval &&
        !readOnly
      ) {
        Promise.resolve(
          onApproval({
            title: msg.method.includes("fileChange")
              ? "Allow file changes?"
              : "Allow this command?",
            detail: JSON.stringify(
              {
                reason: p.reason || "",
                command: p.command || null,
                cwd: p.cwd || cwd,
                changes: items.get(p.itemId)?.changes || null,
                grantRoot: p.grantRoot || null,
              },
              null,
              2,
            ),
          }),
        )
          .then((allow) =>
            send({
              id: msg.id,
              result: { decision: allow ? "accept" : "decline" },
            }),
          )
          .catch(() => send({ id: msg.id, result: { decision: "decline" } }));
      } else if (msg.method === "item/permissions/requestApproval")
        send({ id: msg.id, result: { permissions: {}, scope: "turn" } });
      else if (msg.method === "item/tool/requestUserInput")
        send({ id: msg.id, result: { answers: {} } });
      else
        send({
          id: msg.id,
          error: {
            code: -32601,
            message: "This request is not supported by Roster.",
          },
        });
      return;
    }
    if (msg.method === "item/agentMessage/delta") {
      if (lastMessageItem && lastMessageItem !== p.itemId && text) {
        text += "\n\n";
        onDelta("\n\n");
      }
      lastMessageItem = p.itemId;
      text += p.delta || "";
      onDelta(p.delta || "");
    }
    if (msg.method === "item/started" && p.item) items.set(p.item.id, p.item);
    if (
      msg.method === "item/completed" &&
      p.item?.type === "agentMessage" &&
      !text &&
      p.item.text
    ) {
      text = p.item.text;
      onDelta(text);
    }
    if (
      ["item/started", "item/completed"].includes(msg.method) &&
      ["commandExecution", "fileChange", "webSearch"].includes(p.item?.type)
    ) {
      const item = p.item;
      onEvent({
        type:
          msg.method === "item/started" ? "action.started" : "action.completed",
        detail:
          item.type === "commandExecution"
            ? item.command
            : item.type === "fileChange"
              ? "Updated " + (item.changes || []).map((x) => x.path).join(", ")
              : "Searched the web",
        exitCode: item.exitCode,
        status: item.status,
        itemType: item.type,
      });
    }
    if (msg.method === "thread/tokenUsage/updated") usage = p.tokenUsage;
    if (msg.method === "turn/completed") {
      const t = p.turn;
      if (t?.status === "failed")
        finish(
          new Error(
            t.error?.message || "Codex could not complete this request.",
          ),
        );
      else if (t?.status === "interrupted") finish(new Error("Cancelled"));
      else finish();
    }
    if (msg.method === "error" && !p.willRetry)
      finish(new Error(p.error?.message || "Codex runtime error"));
  });
  const abort = () => {
    if (thread && turn)
      send({
        id: ++serial,
        method: "turn/interrupt",
        params: { threadId: thread, turnId: turn },
      });
    finish(new Error("Cancelled"));
    killTree(child);
  };
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () => {
      finish(
        new Error(
          "This run reached its 15 minute limit. Your conversation is preserved.",
        ),
      );
      killTree(child);
    },
    15 * 60 * 1000,
  );
  try {
    if (signal?.aborted) throw new Error("Cancelled");
    await request("initialize", {
      clientInfo: { name: "roster", title: "Roster", version: "0.1.0" },
    });
    send({ method: "initialized", params: {} });
    const config = {
      cwd,
      approvalPolicy: readOnly ? "never" : "on-request",
      sandbox: "read-only",
      config: { "features.multi_agent": false },
    };
    let result;
    if (threadId) {
      try {
        result = await request("thread/resume", { ...config, threadId });
      } catch {
        onEvent({
          type: "session.recovered",
          detail:
            "Started a new runtime session using saved conversation context.",
        });
      }
    }
    if (!result) result = await request("thread/start", config);
    thread = result.thread.id;
    onSession(thread);
    const started = await request("turn/start", {
      threadId: thread,
      input: [{ type: "text", text: prompt }],
      ...(outputSchema ? { outputSchema } : {}),
    });
    turn = started.turn.id;
    return await done;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    lines.close();
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
    killTree(child);
  }
}

export async function runCompatible({
  prompt,
  config,
  key,
  signal,
  onDelta = () => {},
}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 180000);
  let text = "";
  try {
    if (signal?.aborted) throw new Error("Cancelled");
    const response = await fetch(
      config.endpoint.replace(/\/$/, "") + "/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: prompt }],
          stream: true,
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok)
      throw new Error(
        `Provider returned ${response.status}. Check your endpoint, model and sign-in in Settings.`,
      );
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event.error)
          throw new Error("Provider stream failed. Check runtime settings.");
        const delta = event.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          onDelta(delta);
        }
      }
    }
    if (!text)
      throw new Error(
        "The provider returned no text. Check that this model supports chat completions.",
      );
    return { text };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
