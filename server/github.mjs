import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { id, now } from "./store.mjs";

const exec = promisify(execFile);

export function githubRepository(remote) {
  const value = String(remote || "")
    .trim()
    .replace(/\.git$/i, "");
  const ssh = value.match(/^(?:ssh:\/\/)?git@github\.com[/:]([^/]+\/[^/]+)$/i);
  const https = value.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/i);
  return ssh?.[1] || https?.[1] || "";
}

export function pullRequestState(pullRequest) {
  const checks = Array.isArray(pullRequest.statusCheckRollup)
    ? pullRequest.statusCheckRollup
    : [];
  const failing = checks.filter((check) =>
    ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(
      String(check.conclusion || "").toUpperCase(),
    ),
  );
  const pending = checks.filter((check) =>
    ["QUEUED", "IN_PROGRESS", "PENDING", "WAITING"].includes(
      String(check.status || "").toUpperCase(),
    ),
  );
  if (pullRequest.state === "MERGED")
    return {
      status: "merged",
      reason: "merged",
      detail: "Pull request merged.",
    };
  if (pullRequest.state === "CLOSED")
    return {
      status: "needs_attention",
      reason: "closed",
      detail: "Pull request closed before merge.",
    };
  if (pullRequest.mergeStateStatus === "DIRTY")
    return {
      status: "needs_attention",
      reason: "conflict",
      detail: "Pull request has merge conflicts.",
    };
  if (pullRequest.reviewDecision === "CHANGES_REQUESTED")
    return {
      status: "needs_attention",
      reason: "review",
      detail: "Review changes were requested.",
    };
  if (failing.length)
    return {
      status: "needs_attention",
      reason: "ci",
      detail: `${failing.length} check${failing.length === 1 ? " is" : "s are"} failing.`,
    };
  if (pending.length)
    return {
      status: "monitoring",
      reason: "checks_pending",
      detail: `${pending.length} check${pending.length === 1 ? " is" : "s are"} still running.`,
    };
  return {
    status: "monitoring",
    reason: "healthy",
    detail: pullRequest.isDraft
      ? "Pull request is a draft."
      : "Pull request is ready and checks are passing.",
  };
}

async function repositoryFromWorkspace(workspace) {
  const { stdout } = await exec(
    "git",
    ["config", "--get", "remote.origin.url"],
    {
      cwd: workspace,
      windowsHide: true,
      timeout: 7000,
    },
  );
  const repository = githubRepository(stdout);
  if (!repository)
    throw new Error("This project does not have a GitHub origin remote.");
  return repository;
}

async function inspectPullRequest({ repository, number }) {
  try {
    const { stdout } = await exec(
      "gh",
      [
        "pr",
        "view",
        String(number),
        "--repo",
        repository,
        "--json",
        "number,url,state,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup",
      ],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
    );
    return JSON.parse(stdout);
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error);
    if (/not logged|auth login|authenticate/i.test(detail))
      throw new Error(
        "GitHub CLI authentication is required to monitor pull requests.",
      );
    throw new Error(
      `GitHub pull request check failed: ${detail.slice(0, 500)}`,
    );
  }
}

async function git(args, cwd) {
  try {
    return await exec("git", args, {
      cwd,
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `Git could not prepare this pull request: ${String(error?.stderr || error?.message || error).slice(0, 500)}`,
    );
  }
}

async function defaultBaseBranch(worktree) {
  try {
    const { stdout } = await git(
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      worktree,
    );
    return stdout.trim().replace(/^origin\//, "") || "main";
  } catch {
    return "main";
  }
}

export async function createGithubPullRequest(task, { title, body }) {
  if (!task.worktree_path || !task.branch)
    throw new Error(
      "This task does not have an isolated Git branch to publish.",
    );
  const worktree = task.worktree_path;
  const { stdout: remote } = await git(
    ["config", "--get", "remote.origin.url"],
    worktree,
  );
  const repository = githubRepository(remote);
  if (!repository)
    throw new Error(
      "This task's project does not have a GitHub origin remote.",
    );
  await git(["diff", "--check"], worktree);
  const { stdout: changed } = await git(["status", "--porcelain"], worktree);
  if (changed.trim()) {
    await git(["add", "--all"], worktree);
    await git(["commit", "-m", `Roster: ${title}`.slice(0, 240)], worktree);
  }
  const base = await defaultBaseBranch(worktree);
  await git(["push", "--set-upstream", "origin", task.branch], worktree);
  try {
    const { stdout } = await exec(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        repository,
        "--head",
        task.branch,
        "--base",
        base,
        "--title",
        title,
        "--body",
        body,
      ],
      { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    const url = stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/i);
    if (!url) throw new Error("GitHub did not return a pull request URL.");
    return { repository, number: Number(url[1]), url: url[0] };
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error);
    if (/not logged|auth login|authenticate/i.test(detail))
      throw new Error(
        "GitHub CLI authentication is required to open a pull request.",
      );
    throw new Error(
      `GitHub could not open the pull request: ${detail.slice(0, 500)}`,
    );
  }
}

export function createGithubOwnership(store, event, client = {}) {
  const resolveRepository =
    client.repositoryFromWorkspace || repositoryFromWorkspace;
  const inspect = client.inspectPullRequest || inspectPullRequest;
  const attention = (taskId, reason, detail, number) => {
    const type = `github_${reason}`;
    const existing = store.one(
      "SELECT id FROM attention_items WHERE task_id=? AND type=? AND status='open'",
      [taskId, type],
    );
    if (!existing)
      store.run(
        "INSERT INTO attention_items(id,task_id,type,title,detail,action_json,created_at) VALUES(?,?,?,?,?,?,?)",
        [
          id(),
          taskId,
          type,
          `GitHub pull request #${number} needs attention`,
          detail,
          JSON.stringify({ provider: "github", number, reason }),
          now(),
        ],
      );
  };
  const resolveAttention = (taskId) =>
    store.run(
      "UPDATE attention_items SET status='resolved',resolved_at=? WHERE task_id=? AND type LIKE 'github_%' AND status='open'",
      [now(), taskId],
    );
  const observe = async (monitor) => {
    try {
      const pullRequest = await inspect({
        repository: monitor.repository,
        number: monitor.number,
      });
      const state = pullRequestState(pullRequest);
      const snapshot = JSON.stringify(pullRequest);
      store.run(
        "UPDATE github_ownership SET status=?,detail=?,snapshot_json=?,last_checked_at=?,updated_at=? WHERE id=?",
        [state.status, state.detail, snapshot, now(), now(), monitor.id],
      );
      if (state.status === "needs_attention")
        attention(monitor.task_id, state.reason, state.detail, monitor.number);
      else resolveAttention(monitor.task_id);
      if (monitor.detail !== state.detail || monitor.status !== state.status)
        event(
          monitor.task_id,
          "github.ownership",
          `Pull request #${monitor.number}: ${state.detail}`,
        );
      return store.one("SELECT * FROM github_ownership WHERE id=?", [
        monitor.id,
      ]);
    } catch (error) {
      const detail = String(error.message || error).slice(0, 700);
      store.run(
        "UPDATE github_ownership SET status='unavailable',detail=?,last_checked_at=?,updated_at=? WHERE id=?",
        [detail, now(), now(), monitor.id],
      );
      attention(monitor.task_id, "unavailable", detail, monitor.number);
      return store.one("SELECT * FROM github_ownership WHERE id=?", [
        monitor.id,
      ]);
    }
  };
  return {
    async track(task, number) {
      const workspace = task.repository || task.workspace;
      if (!workspace)
        throw new Error(
          "Attach a GitHub project before tracking a pull request.",
        );
      const repository = await resolveRepository(workspace);
      let monitor = store.one(
        "SELECT * FROM github_ownership WHERE task_id=? AND number=?",
        [task.id, number],
      );
      if (!monitor) {
        const monitorId = id();
        store.run(
          "INSERT INTO github_ownership(id,task_id,repository,number,status,detail,snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
          [
            monitorId,
            task.id,
            repository,
            number,
            "monitoring",
            "Checking pull request.",
            "{}",
            now(),
            now(),
          ],
        );
        monitor = store.one("SELECT * FROM github_ownership WHERE id=?", [
          monitorId,
        ]);
      }
      return observe(monitor);
    },
    async refresh(taskId) {
      const monitors = taskId
        ? store.all("SELECT * FROM github_ownership WHERE task_id=?", [taskId])
        : store.all("SELECT * FROM github_ownership WHERE status!='merged'");
      return Promise.all(monitors.map(observe));
    },
  };
}
