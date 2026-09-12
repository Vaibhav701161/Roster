import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

function git(args, cwd) {
  return exec("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 });
}

export function isGitWorkspace(workspace) {
  if (!workspace || !fs.existsSync(workspace)) return false;
  try {
    return !!execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspace,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return false;
  }
}

export async function provisionWorktree(task) {
  if (!isGitWorkspace(task.workspace)) return null;
  const { stdout: rootOut } = await git(
    ["rev-parse", "--show-toplevel"],
    task.workspace,
  );
  const repository = rootOut.trim();
  const { stdout: headOut } = await git(["rev-parse", "HEAD"], repository);
  const baseCommit = headOut.trim();
  const safeId = task.id.replace(/[^a-z0-9]/gi, "").slice(0, 12);
  const branch = `roster/task-${safeId}`;
  const worktreePath = path.join(
    repository,
    ".roster",
    "worktrees",
    `task-${safeId}`,
  );
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  if (!fs.existsSync(worktreePath))
    await git(
      ["worktree", "add", "-b", branch, worktreePath, baseCommit],
      repository,
    );
  return { repository, baseCommit, branch, worktreePath };
}

export async function taskInspection(task) {
  const cwd = task.worktree_path || task.workspace;
  if (!isGitWorkspace(cwd))
    return {
      available: false,
      reason: "This task does not have a Git workspace.",
    };
  const { stdout: status } = await git(["status", "--porcelain"], cwd);
  const files = status
    .split("\n")
    .filter(Boolean)
    .map((line) => ({
      status: line.slice(0, 2).trim() || "?",
      path: line.slice(3),
    }));
  const base = task.base_commit || "HEAD";
  const { stdout: diff } = await git(
    ["diff", "--no-ext-diff", "--no-color", base, "--", "."],
    cwd,
  );
  return {
    available: true,
    files,
    diff: diff.slice(0, 500000),
    truncated: diff.length > 500000,
  };
}

export async function integrationCheck(task, patch) {
  const repository = task.repository || task.workspace;
  if (!repository || !isGitWorkspace(repository))
    return {
      status: "unavailable",
      detail:
        "This task does not have a Git checkout to check for integration conflicts.",
    };
  const { stdout: status } = await git(["status", "--porcelain"], repository);
  const userChanges = status
    .split("\n")
    .filter(Boolean)
    .filter(
      (line) => !line.slice(3).replace(/\\/g, "/").startsWith(".roster/"),
    );
  if (userChanges.length)
    return {
      status: "blocked",
      detail:
        "Your checkout has uncommitted changes. Review or commit them before checking this task patch.",
    };
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "roster-integration-"),
  );
  const patchFile = path.join(directory, "task.patch");
  try {
    fs.writeFileSync(patchFile, patch, "utf8");
    await git(
      ["apply", "--check", "--whitespace=nowarn", patchFile],
      repository,
    );
    return {
      status: "ready",
      detail: "The task patch applies cleanly to the current checkout.",
    };
  } catch (error) {
    return {
      status: "conflict",
      detail:
        `The task patch does not apply cleanly to the current checkout. ${String(error.stderr || error.message || "")}`.trim(),
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
