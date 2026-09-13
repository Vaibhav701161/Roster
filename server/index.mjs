import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { openStore, id, now } from "./store.mjs";
import { createEngine } from "./engine.mjs";
import { cleanError } from "./runtime.mjs";
import { createVault, providerKey } from "./vault.mjs";
import { acquireLock } from "./lock.mjs";
import { integrationCheck, taskInspection } from "./worktree.mjs";
import {
  integrationTokenConfigured,
  readIntegration,
  refreshIntegrations,
  runCodeRabbitReview,
  saveIntegrationToken,
  supportsIntegrationToken,
} from "./integrations.mjs";
import {
  disableRemoteAccess,
  enableRemoteAccess,
  remoteStatus,
} from "./remote.mjs";
import {
  environmentValue,
  inspectProject,
  projectEnvironment,
  saveProjectEnvironment,
  saveProjectProfile,
} from "./projects.mjs";
import { detectedBrowserScripts, runBrowserScript } from "./browser.mjs";
import {
  callLocalMcpTool,
  callMcpTool,
  discoverLocalMcp,
  discoverMcp,
} from "./mcp.mjs";
import {
  beginMcpAuthorization,
  completeMcpAuthorization,
  mcpAccessToken,
  refreshMcpAuthorization,
} from "./mcp-oauth.mjs";
import {
  createGithubOwnership,
  createGithubPullRequest,
  publishGithubTaskBranch,
} from "./github.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);
const short = z.string().trim().min(1).max(100);
const avatarData = z
  .string()
  .max(500000)
  .refine(
    (value) =>
      !value ||
      /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(value),
    "Use a PNG, JPEG, or WebP avatar under 350 KB.",
  );
const agentSchema = z.object({
  name: short,
  role: short,
  description: z.string().max(3000).default(""),
  instructions: z.string().max(8000).default(""),
  color: z.enum(["green", "blue", "peach", "purple", "gold"]).default("green"),
  provider: z.enum(["auto", "codex", "claude", "compatible"]).default("auto"),
  permission_level: z
    .enum(["read_only", "standard", "autonomous"])
    .default("standard"),
  workspace: z.string().max(1000).default(""),
  avatar_data: avatarData.default(""),
  benched: z.boolean().default(false),
});
const teamSchema = z.object({
  name: short,
  objective: z.string().max(4000).default(""),
  workspace: z.string().max(1000).default(""),
  members: z.array(z.string().uuid()).min(1).max(20),
});
function workspace(value) {
  if (!value) return "";
  const resolved = fs.realpathSync(value);
  if (!fs.statSync(resolved).isDirectory())
    throw new Error("Choose a folder for the workspace.");
  return resolved;
}
export async function createServer({
  directory = process.env.ROSTER_DATA_DIR || path.join(os.homedir(), ".roster"),
  logDirectory = process.env.ROSTER_LOG_DIR || directory,
  port = Number(process.env.ROSTER_PORT || 4318),
  vault,
  runner,
  githubClient,
  integrationFetch,
  integrationCommand,
  remoteCommand,
} = {}) {
  const releaseLock = acquireLock(directory);
  let store;
  try {
    store = await openStore(directory);
  } catch (error) {
    releaseLock();
    throw error;
  }
  const clients = new Set();
  vault ||= createVault(directory);
  const broadcast = (type, data) => {
    for (const res of clients)
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const engine = createEngine(store, broadcast, {
    getKey: () => providerKey(store, vault),
    logDirectory,
    runner,
  });
  const githubOwnership = createGithubOwnership(
    store,
    (taskId, type, detail) => engine.event(taskId, type, detail),
    githubClient,
  );
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  const hashRemoteSecret = (value) =>
    createHash("sha256").update(String(value)).digest("hex");
  const remoteRecords = (key) => {
    const value = store.setting(key, []);
    return Array.isArray(value) ? value : [];
  };
  const remoteIdentity = (req) => {
    const value = String(req.headers["tailscale-user-login"] || "").trim();
    return value.length > 0 && value.length <= 320 ? value : "";
  };
  const remoteSession = (req) => {
    const identity = remoteIdentity(req);
    const cookie = String(req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("roster_remote_session="))
      ?.slice("roster_remote_session=".length);
    if (!identity || !cookie) return null;
    const hashed = hashRemoteSecret(cookie);
    const record = remoteRecords("remoteSessions").find(
      (item) =>
        item?.hash === hashed &&
        item?.identity === identity &&
        Number(item.expiresAt || 0) > Date.now(),
    );
    return record ? { identity, hash: hashed } : null;
  };
  const remoteApiAllowed = (req) => {
    const pathName = req.path;
    if (pathName === "/api/remote/session") return req.method === "POST";
    if (pathName === "/api/remote/signout") return req.method === "POST";
    if (["GET", "HEAD"].includes(req.method))
      return (
        /^\/api\/(state|events)$/.test(pathName) ||
        /^\/api\/conversations\/[^/]+\/messages$/.test(pathName) ||
        /^\/api\/tasks\/[^/]+(?:\/(?:inspection|receipt|browser-checks))?$/.test(
          pathName,
        ) ||
        /^\/api\/files\/[^/]+$/.test(pathName)
      );
    if (req.method === "PATCH")
      return /^\/api\/conversations\/[^/]+$/.test(pathName);
    if (req.method !== "POST") return false;
    return (
      /^\/api\/conversations\/[^/]+\/(?:messages|stop)$/.test(pathName) ||
      /^\/api\/messages\/[^/]+\/reactions$/.test(pathName) ||
      /^\/api\/approvals\/[^/]+$/.test(pathName) ||
      /^\/api\/tasks\/[^/]+\/(?:cancel|retry|verify)$/.test(pathName)
    );
  };
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const host = req.headers.host?.split(":")[0];
    const local = loopbackHosts.has(host);
    const remote =
      !local &&
      store.setting("remoteAccessEnabled", false) === true &&
      !!remoteIdentity(req);
    req.rosterRemote = remote;
    if (!local && !remote)
      return res.status(403).json({ error: "Private local access only." });
    const origin = req.headers.origin;
    const sameOrigin =
      origin === `${remote ? "https" : "http"}://${req.headers.host}`;
    const viteOrigin = /^http:\/\/(127\.0\.0\.1|localhost):5173$/.test(
      origin || "",
    );
    if (origin && !sameOrigin && !(local && viteOrigin))
      return res.status(403).json({ error: "Untrusted origin." });
    if (req.headers["sec-fetch-site"] === "cross-site")
      return res.status(403).json({ error: "Cross-site access denied." });
    if (!["GET", "HEAD"].includes(req.method) && !req.is("application/json"))
      return res.status(415).json({ error: "JSON requests required." });
    if (
      remote &&
      req.path.startsWith("/api/") &&
      req.path !== "/api/remote/session" &&
      !remoteSession(req)
    )
      return res
        .status(401)
        .json({ error: "Pair this phone before using Roster." });
    if (remote && req.path.startsWith("/api/") && !remoteApiAllowed(req))
      return res
        .status(403)
        .json({ error: "This action remains available only on the desktop." });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; worker-src 'self'; frame-ancestors 'none'",
    );
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  const changed = () => broadcast("state.changed", {});
  const usableMcpAccessToken = async (connection) => {
    if (connection.transport !== "remote") return "";
    let metadata = {};
    try {
      metadata = JSON.parse(connection.auth_metadata_json || "{}");
    } catch {
      return mcpAccessToken(connection, vault);
    }
    const expiry = metadata.oauth?.expires_at;
    if (
      typeof expiry !== "number" ||
      expiry > Date.now() + 30000 ||
      !mcpAccessToken(connection, vault)
    )
      return mcpAccessToken(connection, vault);
    const refreshed = await refreshMcpAuthorization({ connection, vault });
    store.run(
      "UPDATE mcp_connections SET auth_metadata_json=?,detail=?,updated_at=? WHERE id=?",
      [
        JSON.stringify(refreshed.authMetadata),
        "Authorization token refreshed for the connected MCP server.",
        now(),
        connection.id,
      ],
    );
    return refreshed.accessToken;
  };
  const must = (table, key) => {
    const row = store.one(`SELECT * FROM ${table} WHERE id=?`, [key]);
    if (!row)
      throw new Error("This item no longer exists. Refresh to continue.");
    return row;
  };
  const reconcileIntegrationAttention = () => {
    const integrations = store.all(
      "SELECT id,provider,name,status,detail,workspace_scope_json FROM integrations",
    );
    for (const integration of integrations) {
      let scoped = [];
      try {
        scoped = JSON.parse(integration.workspace_scope_json || "[]");
      } catch {
        scoped = [];
      }
      const type = `integration_${integration.provider}`;
      const needsAttention =
        Array.isArray(scoped) &&
        scoped.length > 0 &&
        !["connected", "available"].includes(integration.status);
      if (needsAttention) {
        if (
          !store.one(
            "SELECT id FROM attention_items WHERE type=? AND status='open'",
            [type],
          )
        )
          store.run(
            "INSERT INTO attention_items(id,task_id,type,title,detail,action_json,created_at) VALUES(?,?,?,?,?,?,?)",
            [
              id(),
              null,
              type,
              `${integration.name} needs attention`,
              integration.detail ||
                "This project-scoped integration is unavailable.",
              JSON.stringify({ provider: integration.provider }),
              now(),
            ],
          );
      } else
        store.run(
          "UPDATE attention_items SET status='resolved',resolved_at=? WHERE type=? AND status='open'",
          [now(), type],
        );
    }
  };
  const monitorSentryIssues = async () => {
    const monitors = store.all(
      "SELECT m.*,i.provider,i.name,i.status FROM integration_monitors m JOIN integrations i ON i.id=m.integration_id WHERE m.enabled=1 AND i.provider='sentry' AND i.status='connected'",
    );
    for (const monitor of monitors) {
      let config = {},
        seen = [];
      try {
        config = JSON.parse(monitor.config_json || "{}");
        seen = JSON.parse(monitor.seen_json || "[]");
      } catch {
        continue;
      }
      const issues = await readIntegration(
        "sentry",
        vault,
        config,
        integrationFetch,
      );
      const issueIds = issues.map((issue) => issue.id).filter(Boolean);
      if (seen.length) {
        for (const issue of issues.filter(
          (issue) => !seen.includes(issue.id),
        )) {
          const type = `sentry_issue_${issue.id}`.slice(0, 200);
          if (
            store.one(
              "SELECT id FROM attention_items WHERE type=? AND status='open'",
              [type],
            )
          )
            continue;
          store.run(
            "INSERT INTO attention_items(id,task_id,type,title,detail,status,action_json,created_at) VALUES(?,?,?,?,?,'open',?,?)",
            [
              id(),
              null,
              type,
              `New Sentry issue: ${issue.title}`.slice(0, 240),
              `${issue.level || "unknown"} issue seen ${issue.count || 0} times. Review the attributed Sentry evidence before assigning work.`.slice(
                0,
                1200,
              ),
              JSON.stringify({ provider: "sentry", issue }),
              now(),
            ],
          );
        }
      }
      store.run(
        "UPDATE integration_monitors SET seen_json=?,updated_at=? WHERE integration_id=?",
        [JSON.stringify(issueIds.slice(0, 100)), now(), monitor.integration_id],
      );
    }
  };
  const settleOutcome = (outcome, evidence = "") => {
    const remaining = store.one(
      "SELECT COUNT(*) count FROM acceptance_criteria WHERE outcome_id=? AND status!='pass'",
      [outcome.id],
    ).count;
    const status = remaining ? "verifying" : "satisfied";
    store.run("UPDATE outcome_contracts SET status=?,updated_at=? WHERE id=?", [
      status,
      now(),
      outcome.id,
    ]);
    if (remaining) return false;
    const task = must("tasks", outcome.task_id);
    const receipt = store.one("SELECT id FROM work_receipts WHERE task_id=?", [
      task.id,
    ]);
    if (!receipt) {
      const review = store.one(
        "SELECT summary FROM review_verdicts WHERE task_id=? AND verdict='pass'",
        [task.id],
      );
      store.run(
        "INSERT INTO work_receipts(id,task_id,outcome_id,content,created_at) VALUES(?,?,?,?,?)",
        [
          id(),
          task.id,
          outcome.id,
          `# ${task.title}\n\nOutcome completed.\n\nVerification: all recorded acceptance criteria passed.${review ? `\n\nIndependent review: ${review.summary}` : ""}${evidence ? `\n\nLatest evidence: ${evidence}` : ""}`,
          now(),
        ],
      );
    }
    return true;
  };
  function snapshot(remote = false) {
    const tasks = store.all(
      "SELECT id,conversation_id,message_id,owner_id,title,status,kind,workspace,error,verification,created_at,started_at,completed_at,'' result,'' objective,root_task_id,repository,base_commit,branch,worktree_path,(SELECT COUNT(*) FROM acceptance_criteria c JOIN outcome_contracts o ON o.id=c.outcome_id WHERE o.task_id=tasks.id) criteria_total,(SELECT COUNT(*) FROM acceptance_criteria c JOIN outcome_contracts o ON o.id=c.outcome_id WHERE o.task_id=tasks.id AND c.status='pass') criteria_passed,EXISTS(SELECT 1 FROM work_receipts r WHERE r.task_id=tasks.id) has_receipt FROM tasks ORDER BY CASE WHEN status IN ('running','waiting_approval','queued','waiting_dependency') THEN 0 ELSE 1 END,created_at DESC LIMIT 500",
    );
    const agents = store
      .all("SELECT * FROM agents ORDER BY created_at")
      .map((a) => ({
        ...a,
        benched: !!a.benched,
        status: a.benched
          ? "benched"
          : tasks.some(
                (t) => t.owner_id === a.id && t.status === "waiting_approval",
              )
            ? "needs_you"
            : tasks.some((t) => t.owner_id === a.id && t.status === "running")
              ? "working"
              : "available",
      }));
    const teams = store
      .all("SELECT * FROM teams ORDER BY created_at")
      .map((t) => ({
        ...t,
        members: store
          .all("SELECT agent_id FROM team_members WHERE team_id=?", [t.id])
          .map((m) => m.agent_id),
      }));
    const conversations = store.all(
      `SELECT c.*, (SELECT substr(content,1,140) FROM messages WHERE conversation_id=c.id ORDER BY rowid DESC LIMIT 1) preview,(SELECT COUNT(*) FROM messages WHERE conversation_id=c.id AND role='assistant' AND created_at>COALESCE(c.read_at,c.created_at)) unread FROM conversations c ORDER BY pinned DESC,updated_at DESC`,
    );
    return {
      agents: remote
        ? agents.map(
            ({
              id,
              name,
              role,
              description,
              color,
              benched,
              status,
              created_at,
            }) => ({
              id,
              name,
              role,
              description,
              color,
              benched,
              status,
              created_at,
              instructions: "",
              provider: "",
              permission_level: "standard",
              workspace: "",
              avatar_data: "",
            }),
          )
        : agents,
      teams: remote ? teams.map((team) => ({ ...team, workspace: "" })) : teams,
      conversations,
      tasks: remote
        ? tasks.map((task) => ({ ...task, workspace: "", worktree_path: "" }))
        : tasks,
      approvals: store.all(
        "SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100",
      ),
      needsYou: store.all(
        "SELECT * FROM attention_items WHERE status='open' ORDER BY created_at DESC LIMIT 100",
      ),
      memories: remote ? [] : store.all("SELECT * FROM memories"),
      integrations: remote
        ? []
        : store
            .all("SELECT * FROM integrations ORDER BY name")
            .map((integration) => ({
              ...integration,
              credential_configurable: supportsIntegrationToken(
                integration.provider,
              ),
              credential_configured: integrationTokenConfigured(
                vault,
                integration.provider,
              ),
            })),
      githubOwnership: remote
        ? []
        : store.all(
            "SELECT * FROM github_ownership ORDER BY updated_at DESC LIMIT 100",
          ),
      mcpConnections: remote
        ? []
        : store.all("SELECT * FROM mcp_connections ORDER BY updated_at DESC"),
      projectProfiles: remote
        ? []
        : store
            .all(
              "SELECT id,workspace,name,resources_json,updated_at FROM project_profiles ORDER BY updated_at DESC",
            )
            .map((profile) => ({
              ...profile,
              environment: environmentValue(
                projectEnvironment(store, profile.workspace),
              ),
              resources: JSON.parse(profile.resources_json || "[]"),
            })),
      providers: remote ? [] : engine.health,
      planning: [...engine.planning.keys()],
      settings: {
        theme: store.setting("theme", "light"),
        wallpaper: store.setting("wallpaper", "classic"),
        parallelLimit: store.setting("parallelLimit", 2),
        repairLimit: store.setting("repairLimit", 3),
        compatible: remote ? null : store.setting("compatible"),
        hasKey: remote ? false : !!providerKey(store, vault),
        canSaveKey: remote ? false : !!vault,
        keyStorage: remote ? "encrypted" : vault.mode || "encrypted",
        directory: remote ? "" : directory,
        workspaceName: store.setting("workspaceName", "Personal workspace"),
        remoteSession: remote,
      },
    };
  }
  app.get("/api/state", (req, res) => res.json(snapshot(!!req.rosterRemote)));
  const cleanRemoteRecords = (key) => {
    const records = remoteRecords(key).filter(
      (record) => Number(record?.expiresAt || 0) > Date.now(),
    );
    store.setSetting(key, records);
    return records;
  };
  const requireDesktop = (req) => {
    if (req.rosterRemote)
      throw new Error("This action remains available only on the desktop.");
  };
  const remoteInfo = async () => {
    const network = await remoteStatus(remoteCommand);
    const enabled = store.setting("remoteAccessEnabled", false) === true;
    return {
      ...network,
      enabled,
      url: enabled
        ? store.setting("remoteAccessUrl", network.url) || network.url
        : "",
    };
  };
  app.get("/api/remote/status", async (req, res) => {
    requireDesktop(req);
    res.json(await remoteInfo());
  });
  app.post("/api/remote/enable", async (req, res) => {
    requireDesktop(req);
    const address = server?.address();
    const localPort = typeof address === "object" && address ? address.port : 0;
    if (!localPort)
      throw new Error("Roster is still starting. Try again shortly.");
    const network = await enableRemoteAccess(localPort, remoteCommand);
    store.setSetting("remoteAccessEnabled", true);
    store.setSetting("remoteAccessUrl", network.url);
    changed();
    res.json({ ...network, enabled: true });
  });
  app.post("/api/remote/disable", async (req, res) => {
    requireDesktop(req);
    await disableRemoteAccess(remoteCommand);
    store.setSetting("remoteAccessEnabled", false);
    store.setSetting("remoteAccessUrl", "");
    store.setSetting("remotePairings", []);
    store.setSetting("remoteSessions", []);
    changed();
    res.json({ ok: true });
  });
  app.post("/api/remote/pairings", (req, res) => {
    requireDesktop(req);
    if (store.setting("remoteAccessEnabled", false) !== true)
      throw new Error("Enable private remote access before pairing a phone.");
    const url = store.setting("remoteAccessUrl", "");
    if (!/^https:\/\/[a-z0-9][a-z0-9.-]{0,252}$/i.test(url))
      throw new Error(
        "Roster could not determine this desktop's private address.",
      );
    const secret = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + 15 * 60 * 1000;
    const pairings = cleanRemoteRecords("remotePairings").slice(-4);
    pairings.push({ hash: hashRemoteSecret(secret), expiresAt });
    store.setSetting("remotePairings", pairings);
    res.json({ url: `${url}/#pair=${secret}`, expiresAt });
  });
  app.post("/api/remote/session", (req, res) => {
    if (!req.rosterRemote)
      return res
        .status(403)
        .json({ error: "Pair from Roster's private address." });
    const authorization = String(req.headers.authorization || "");
    const secret = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    if (!/^[A-Za-z0-9_-]{40,120}$/.test(secret))
      return res
        .status(401)
        .json({ error: "Pairing link is invalid or expired." });
    const hash = hashRemoteSecret(secret);
    const pairings = cleanRemoteRecords("remotePairings");
    if (!pairings.some((pairing) => pairing.hash === hash))
      return res
        .status(401)
        .json({ error: "Pairing link is invalid or expired." });
    store.setSetting(
      "remotePairings",
      pairings.filter((pairing) => pairing.hash !== hash),
    );
    const identity = remoteIdentity(req);
    const sessionSecret = randomBytes(32).toString("base64url");
    const sessions = cleanRemoteRecords("remoteSessions")
      .filter((session) => session.identity !== identity)
      .slice(-9);
    sessions.push({
      hash: hashRemoteSecret(sessionSecret),
      identity,
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    store.setSetting("remoteSessions", sessions);
    res.setHeader(
      "Set-Cookie",
      `roster_remote_session=${sessionSecret}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 24 * 60 * 60}`,
    );
    res.json({ ok: true });
  });
  app.post("/api/remote/signout", (req, res) => {
    if (!req.rosterRemote)
      return res.status(403).json({ error: "Use the private Roster address." });
    const session = remoteSession(req);
    if (!session)
      return res
        .status(401)
        .json({ error: "Pair this phone before using Roster." });
    store.setSetting(
      "remoteSessions",
      cleanRemoteRecords("remoteSessions").filter(
        (record) => record.hash !== session.hash,
      ),
    );
    res.setHeader(
      "Set-Cookie",
      "roster_remote_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
    );
    res.json({ ok: true });
  });
  app.post("/api/projects/inspect", (req, res) => {
    const target = workspace(
      z.object({ workspace: z.string().max(1000) }).parse(req.body).workspace,
    );
    if (!target) throw new Error("Choose a project folder first.");
    res.json(inspectProject(target));
  });
  app.post("/api/projects/profile", (req, res) => {
    const target = workspace(
      z.object({ workspace: z.string().max(1000) }).parse(req.body).workspace,
    );
    if (!target) throw new Error("Choose a project folder first.");
    const profile = saveProjectProfile(store, target);
    changed();
    res.json(profile);
  });
  const projectEnvironmentSchema = z.object({
    workspace: z.string().max(1000),
    setup: z.array(z.string().trim().min(1).max(500)).max(20),
    filesToCopy: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(300)
          .refine(
            (value) =>
              !path.isAbsolute(value) && !value.split(/[\\/]+/).includes(".."),
            "Copy paths must stay inside the project.",
          ),
      )
      .max(20),
    devCommand: z.string().trim().max(1000),
    testCommand: z.string().trim().max(1000),
    buildCommand: z.string().trim().max(1000),
  });
  app.get("/api/projects/environment", (req, res) => {
    const target = workspace(
      z.object({ workspace: z.string().max(1000) }).parse(req.query).workspace,
    );
    const environment = projectEnvironment(store, target);
    if (!environment) throw new Error("Save this project as a profile first.");
    res.json(environmentValue(environment));
  });
  app.put("/api/projects/environment", (req, res) => {
    const body = projectEnvironmentSchema.parse(req.body);
    const target = workspace(body.workspace);
    if (
      !store.one("SELECT id FROM project_profiles WHERE workspace=?", [target])
    )
      throw new Error(
        "Save this project as a profile before editing its environment.",
      );
    const detected = inspectProject(target).environment.detected;
    const environment = saveProjectEnvironment(store, target, {
      ...body,
      workspace: undefined,
      detected,
    });
    changed();
    res.json(environment);
  });
  app.post("/api/integrations/refresh", async (req, res) => {
    const integrations = await refreshIntegrations(store, vault, {
      fetchFn: integrationFetch,
    });
    reconcileIntegrationAttention();
    changed();
    res.json({ integrations });
  });
  app.put("/api/integrations/:id/token", async (req, res) => {
    const integration = must("integrations", req.params.id);
    const { token } = z
      .object({ token: z.string().trim().max(10000) })
      .parse(req.body);
    saveIntegrationToken(vault, integration.provider, token);
    await refreshIntegrations(store, vault, { fetchFn: integrationFetch });
    reconcileIntegrationAttention();
    changed();
    res.json({
      provider: integration.provider,
      configured: integrationTokenConfigured(vault, integration.provider),
    });
  });
  app.post("/api/integrations/:id/read", async (req, res) => {
    const integration = must("integrations", req.params.id);
    const input = z
      .object({
        organization: z.string().max(100).optional(),
        project: z.string().max(100).optional(),
        query: z.string().max(300).optional(),
        workspace: z.string().max(1000).optional(),
      })
      .parse(req.body);
    const scoped = JSON.parse(integration.workspace_scope_json || "[]");
    if (scoped.length && !input.workspace)
      throw new Error("Select a project allowed for this integration.");
    if (
      input.workspace &&
      scoped.length &&
      !scoped.includes(workspace(input.workspace))
    )
      throw new Error("This integration is not allowed for that project.");
    const result = await readIntegration(
      integration.provider,
      vault,
      input,
      integrationFetch,
      integrationCommand,
    );
    res.json({ result });
  });
  app.put("/api/integrations/:id/sentry-watch", async (req, res) => {
    const integration = must("integrations", req.params.id);
    if (integration.provider !== "sentry")
      throw new Error("Only Sentry supports this production issue watch.");
    const config = z
      .object({
        enabled: z.boolean(),
        organization: z.string().trim().max(100),
        project: z.string().trim().max(100).optional(),
        query: z.string().trim().max(300).optional(),
      })
      .parse(req.body);
    if (
      config.enabled &&
      !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(config.organization)
    )
      throw new Error("Enter a Sentry organization slug.");
    store.run(
      "INSERT INTO integration_monitors(integration_id,config_json,seen_json,enabled,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(integration_id) DO UPDATE SET config_json=excluded.config_json,seen_json=excluded.seen_json,enabled=excluded.enabled,updated_at=excluded.updated_at",
      [
        integration.id,
        JSON.stringify(config),
        "[]",
        config.enabled ? 1 : 0,
        now(),
      ],
    );
    if (config.enabled) await monitorSentryIssues();
    changed();
    res.json({ ...config, baseline: config.enabled });
  });
  app.post("/api/integrations/:id/sentry-watch/check", async (req, res) => {
    const integration = must("integrations", req.params.id);
    if (integration.provider !== "sentry")
      throw new Error("Only Sentry supports this production issue watch.");
    if (
      !store.one(
        "SELECT integration_id FROM integration_monitors WHERE integration_id=? AND enabled=1",
        [integration.id],
      )
    )
      throw new Error("Start a Sentry issue watch before checking it.");
    await monitorSentryIssues();
    changed();
    res.json({ ok: true });
  });
  app.put("/api/integrations/:id/scopes", (req, res) => {
    const integration = must("integrations", req.params.id);
    const { workspaces } = z
      .object({ workspaces: z.array(z.string().max(1000)).max(20) })
      .parse(req.body);
    const scopes = [...new Set(workspaces.filter(Boolean).map(workspace))];
    for (const scopedWorkspace of scopes)
      if (
        !store.one("SELECT id FROM project_profiles WHERE workspace=?", [
          scopedWorkspace,
        ])
      )
        throw new Error(
          "Save this project as a profile before assigning an integration to it.",
        );
    store.run(
      "UPDATE integrations SET workspace_scope_json=?,updated_at=? WHERE id=?",
      [JSON.stringify(scopes), now(), integration.id],
    );
    reconcileIntegrationAttention();
    changed();
    res.json({ ...integration, workspace_scope_json: JSON.stringify(scopes) });
  });
  app.post("/api/tasks/:id/github-pull-request", async (req, res) => {
    const task = must("tasks", req.params.id);
    const { number } = z
      .object({ number: z.number().int().positive().max(100000000) })
      .parse(req.body);
    const ownership = await githubOwnership.track(task, number);
    changed();
    res.json(ownership);
  });
  app.post("/api/tasks/:id/github-pull-request/refresh", async (req, res) => {
    must("tasks", req.params.id);
    const ownership = await githubOwnership.refresh(req.params.id);
    changed();
    res.json(ownership);
  });
  app.post("/api/tasks/:id/github-pull-request/create", async (req, res) => {
    const task = must("tasks", req.params.id);
    if (task.status !== "completed")
      throw new Error("Complete the task before opening a pull request.");
    const body = z
      .object({
        title: z.string().trim().min(3).max(240).default(task.title),
        body: z.string().trim().min(3).max(10000),
      })
      .parse(req.body);
    const publish = githubClient?.createPullRequest || createGithubPullRequest;
    const pullRequest = await publish(task, body);
    const ownership = await githubOwnership.track(task, pullRequest.number);
    engine.event(
      task.id,
      "github.pull_request_created",
      `Published task branch and opened ${pullRequest.url}.`,
    );
    changed();
    res.json({ pullRequest, ownership });
  });
  app.post("/api/tasks/:id/github-pull-request/publish", async (req, res) => {
    const task = must("tasks", req.params.id);
    if (task.status !== "completed")
      throw new Error("Complete the task before publishing its branch update.");
    const rootId = task.root_task_id || task.id;
    const root = must("tasks", rootId);
    const monitor = store.one(
      "SELECT * FROM github_ownership WHERE task_id=? ORDER BY updated_at DESC LIMIT 1",
      [root.id],
    );
    if (!monitor)
      throw new Error(
        "Track a pull request before publishing additional task changes.",
      );
    const title = z
      .object({ title: z.string().trim().min(3).max(240).default(task.title) })
      .parse(req.body).title;
    const publish = githubClient?.publishTaskBranch || publishGithubTaskBranch;
    const branch = await publish(task, { title });
    const ownership = await githubOwnership.track(root, monitor.number);
    engine.event(
      task.id,
      "github.branch_published",
      `Published ${branch.branch} to update pull request #${monitor.number}.`,
    );
    changed();
    res.json({ branch, ownership });
  });
  app.post("/api/mcp/discover", async (req, res) => {
    const { url } = z
      .object({ url: z.string().trim().min(1).max(2000) })
      .parse(req.body);
    const connection = await discoverMcp(url);
    store.run(
      "INSERT INTO mcp_connections(id,url,server_name,status,detail,protocol_version,capabilities_json,auth_metadata_json,tools_json,transport,stdio_json,discovered_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET server_name=excluded.server_name,status=excluded.status,detail=excluded.detail,protocol_version=excluded.protocol_version,capabilities_json=excluded.capabilities_json,auth_metadata_json=excluded.auth_metadata_json,tools_json=excluded.tools_json,transport=excluded.transport,stdio_json=excluded.stdio_json,updated_at=excluded.updated_at",
      [
        connection.id,
        connection.url,
        connection.serverName,
        connection.status,
        connection.detail,
        connection.protocolVersion,
        JSON.stringify(connection.capabilities),
        JSON.stringify(connection.authMetadata),
        JSON.stringify(connection.tools || []),
        connection.transport,
        JSON.stringify(connection.stdio || {}),
        now(),
        now(),
      ],
    );
    changed();
    res.json(connection);
  });
  app.post("/api/mcp/discover-local", async (req, res) => {
    const config = z
      .object({
        command: z.string().trim().min(1).max(1000),
        args: z.array(z.string().max(2000)).max(50).default([]),
      })
      .parse(req.body);
    const connection = await discoverLocalMcp(config);
    store.run(
      "INSERT INTO mcp_connections(id,url,server_name,status,detail,protocol_version,capabilities_json,auth_metadata_json,tools_json,transport,stdio_json,discovered_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET server_name=excluded.server_name,status=excluded.status,detail=excluded.detail,protocol_version=excluded.protocol_version,capabilities_json=excluded.capabilities_json,auth_metadata_json=excluded.auth_metadata_json,tools_json=excluded.tools_json,transport=excluded.transport,stdio_json=excluded.stdio_json,updated_at=excluded.updated_at",
      [
        connection.id,
        connection.url,
        connection.serverName,
        connection.status,
        connection.detail,
        connection.protocolVersion,
        JSON.stringify(connection.capabilities),
        JSON.stringify(connection.authMetadata),
        JSON.stringify(connection.tools || []),
        connection.transport,
        JSON.stringify(connection.stdio || {}),
        now(),
        now(),
      ],
    );
    changed();
    res.json(connection);
  });
  app.post("/api/mcp/:id/authorize", async (req, res) => {
    const connection = must("mcp_connections", req.params.id);
    if (connection.transport !== "remote")
      throw new Error(
        "Local MCP servers do not require browser authorization.",
      );
    if (connection.status !== "authentication_required")
      throw new Error(
        "Discover an MCP server that requires authorization first.",
      );
    const redirectUri = `http://${req.headers.host}/api/mcp/${connection.id}/oauth/callback`;
    const authorization = await beginMcpAuthorization({
      connection,
      vault,
      redirectUri,
    });
    store.run(
      "UPDATE mcp_connections SET auth_metadata_json=?,detail=?,updated_at=? WHERE id=?",
      [
        JSON.stringify(authorization.authMetadata),
        "Authorization is open in your browser. Finish sign-in there, then return to Roster.",
        now(),
        connection.id,
      ],
    );
    changed();
    res.json({ authorizationUrl: authorization.authorizationUrl });
  });
  app.get("/api/mcp/:id/oauth/callback", async (req, res) => {
    const connection = must("mcp_connections", req.params.id);
    if (req.query.error)
      throw new Error(
        "Authorization was not completed by the account provider.",
      );
    const code = z
      .string()
      .min(1)
      .max(10000)
      .parse(req.query.code || "");
    const state = z
      .string()
      .min(1)
      .max(1000)
      .parse(req.query.state || "");
    const redirectUri = `http://${req.headers.host}/api/mcp/${connection.id}/oauth/callback`;
    const completed = await completeMcpAuthorization({
      connection,
      vault,
      code,
      state,
      redirectUri,
    });
    const refreshed = await discoverMcp(connection.url, completed.accessToken);
    if (refreshed.status !== "available")
      throw new Error(
        "Authorization succeeded but the MCP server did not accept the access token.",
      );
    store.run(
      "UPDATE mcp_connections SET server_name=?,status=?,detail=?,protocol_version=?,capabilities_json=?,auth_metadata_json=?,tools_json=?,updated_at=? WHERE id=?",
      [
        refreshed.serverName,
        refreshed.status,
        "Authorization is connected. The server accepted a token-backed initialization request.",
        refreshed.protocolVersion,
        JSON.stringify(refreshed.capabilities),
        JSON.stringify(completed.authMetadata),
        JSON.stringify(refreshed.tools || []),
        now(),
        connection.id,
      ],
    );
    changed();
    res
      .type("html")
      .send(
        `<!doctype html><title>Roster connected</title><main><h1>Connected</h1><p>You can close this tab and return to Roster.</p></main>`,
      );
  });
  app.put("/api/mcp/:id/scopes", (req, res) => {
    const connection = must("mcp_connections", req.params.id);
    const { workspaces } = z
      .object({ workspaces: z.array(z.string().max(1000)).max(20) })
      .parse(req.body);
    const scopes = [...new Set(workspaces.filter(Boolean).map(workspace))];
    store.run(
      "UPDATE mcp_connections SET workspace_scope_json=?,updated_at=? WHERE id=?",
      [JSON.stringify(scopes), now(), connection.id],
    );
    changed();
    res.json({ ...connection, workspace_scope_json: JSON.stringify(scopes) });
  });
  app.post("/api/mcp/:id/tools/call", async (req, res) => {
    const connection = must("mcp_connections", req.params.id);
    if (connection.status !== "available")
      throw new Error("Connect this MCP server before calling a tool.");
    const body = z
      .object({
        name: z.string().trim().min(1).max(200),
        arguments: z.record(z.string(), z.unknown()).default({}),
        workspace: z.string().max(1000).default(""),
      })
      .parse(req.body);
    const scopes = JSON.parse(connection.workspace_scope_json || "[]");
    if (scopes.length) {
      const requestedWorkspace = body.workspace
        ? workspace(body.workspace)
        : "";
      if (!scopes.includes(requestedWorkspace))
        throw new Error(
          "Choose a workspace that this MCP server is explicitly connected to.",
        );
    }
    const tools = JSON.parse(connection.tools_json || "[]");
    if (!tools.some((tool) => tool.name === body.name))
      throw new Error(
        "Only tools in this server's discovered registry can run.",
      );
    const argumentSize = JSON.stringify(body.arguments).length;
    if (argumentSize > 50000)
      throw new Error("MCP tool arguments must be 50 KB or smaller.");
    const callId = id();
    store.run(
      "INSERT INTO mcp_tool_calls(id,connection_id,tool_name,argument_keys_json,status,created_at) VALUES(?,?,?,?,?,?)",
      [
        callId,
        connection.id,
        body.name,
        JSON.stringify(Object.keys(body.arguments).sort()),
        "running",
        now(),
      ],
    );
    try {
      const result =
        connection.transport === "stdio"
          ? await callLocalMcpTool(
              JSON.parse(connection.stdio_json || "{}"),
              body.name,
              body.arguments,
            )
          : await callMcpTool(
              connection.url,
              body.name,
              body.arguments,
              await usableMcpAccessToken(connection),
            );
      const summary = JSON.stringify(result).slice(0, 2000);
      store.run(
        "UPDATE mcp_tool_calls SET status='completed',summary=?,completed_at=? WHERE id=?",
        [summary, now(), callId],
      );
      changed();
      res.json({ id: callId, result });
    } catch (error) {
      store.run(
        "UPDATE mcp_tool_calls SET status='failed',summary=?,completed_at=? WHERE id=?",
        [cleanError(error), now(), callId],
      );
      changed();
      throw error;
    }
  });
  app.post("/api/tasks/:id/mcp-evidence", async (req, res) => {
    const task = must("tasks", req.params.id);
    if (task.status !== "completed")
      throw new Error("Complete the work before collecting MCP evidence.");
    const body = z
      .object({
        connectionId: z.string().min(1).max(100),
        name: z.string().trim().min(1).max(200),
        arguments: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(req.body);
    const connection = must("mcp_connections", body.connectionId);
    if (connection.status !== "available")
      throw new Error("Connect this MCP server before collecting evidence.");
    const tools = JSON.parse(connection.tools_json || "[]");
    if (!tools.some((tool) => tool.name === body.name))
      throw new Error(
        "Only tools in this server's discovered registry can run.",
      );
    if (JSON.stringify(body.arguments).length > 50000)
      throw new Error("MCP tool arguments must be 50 KB or smaller.");
    const scopes = JSON.parse(connection.workspace_scope_json || "[]");
    if (scopes.length && !scopes.includes(task.workspace))
      throw new Error(
        "This MCP server is not connected to this task's project.",
      );
    const callId = id();
    store.run(
      "INSERT INTO mcp_tool_calls(id,connection_id,tool_name,argument_keys_json,status,created_at) VALUES(?,?,?,?,?,?)",
      [
        callId,
        connection.id,
        body.name,
        JSON.stringify(Object.keys(body.arguments).sort()),
        "running",
        now(),
      ],
    );
    try {
      const result =
        connection.transport === "stdio"
          ? await callLocalMcpTool(
              JSON.parse(connection.stdio_json || "{}"),
              body.name,
              body.arguments,
            )
          : await callMcpTool(
              connection.url,
              body.name,
              body.arguments,
              await usableMcpAccessToken(connection),
            );
      const output = JSON.stringify(result, null, 2).slice(0, 200000);
      store.transaction(() => {
        store.run(
          "UPDATE mcp_tool_calls SET status='completed',summary=?,completed_at=? WHERE id=?",
          [output.slice(0, 2000), now(), callId],
        );
        const artifactId = id();
        store.run(
          "INSERT INTO artifacts(id,task_id,conversation_id,name,content,size,created_at) VALUES(?,?,?,?,?,?,?)",
          [
            artifactId,
            task.id,
            task.conversation_id,
            `${connection.server_name} ${body.name} evidence.json`.slice(
              0,
              200,
            ),
            output,
            Buffer.byteLength(output),
            now(),
          ],
        );
        const outcome = store.one(
          "SELECT * FROM outcome_contracts WHERE task_id=?",
          [task.id],
        );
        store.run(
          "INSERT INTO evidence(id,task_id,outcome_id,type,source,status,summary,artifact_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
          [
            id(),
            task.id,
            outcome?.id || null,
            "external_tool",
            `MCP: ${connection.server_name}/${body.name}`,
            "informational",
            `Collected external evidence from ${connection.server_name}/${body.name}.`,
            artifactId,
            now(),
          ],
        );
        if (outcome) {
          const command = `mcp:${connection.id}/${body.name}`;
          if (
            !store.one(
              "SELECT id FROM acceptance_criteria WHERE outcome_id=? AND type='external_tool' AND command=?",
              [outcome.id, command],
            )
          )
            store.run(
              "INSERT INTO acceptance_criteria(id,outcome_id,type,description,command,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
              [
                id(),
                outcome.id,
                "external_tool",
                `Review external evidence from ${connection.server_name}/${body.name}`,
                command,
                now(),
                now(),
              ],
            );
          store.run(
            "UPDATE outcome_contracts SET status='verifying',updated_at=? WHERE id=?",
            [now(), outcome.id],
          );
          store.run("UPDATE tasks SET verification='unverified' WHERE id=?", [
            task.id,
          ]);
          store.run("DELETE FROM work_receipts WHERE task_id=?", [task.id]);
        }
      });
      engine.event(
        task.id,
        "mcp.evidence_collected",
        `${connection.server_name}/${body.name} output was saved as external evidence.`,
      );
      changed();
      res.json({ id: callId, result });
    } catch (error) {
      store.run(
        "UPDATE mcp_tool_calls SET status='failed',summary=?,completed_at=? WHERE id=?",
        [cleanError(error), now(), callId],
      );
      changed();
      throw error;
    }
  });
  app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    res.write("event: connected\ndata: {}\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
  });
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(": heartbeat\n\n");
  }, 20000);
  heartbeat.unref();
  app.post("/api/agents", (req, res) => {
    const a = agentSchema.parse(req.body);
    a.workspace = workspace(a.workspace);
    const aid = id(),
      cid = id();
    store.transaction(() => {
      store.run(
        "INSERT INTO agents(id,name,role,description,instructions,color,provider,workspace,benched,created_at,permission_level,avatar_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          aid,
          a.name,
          a.role,
          a.description,
          a.instructions,
          a.color,
          a.provider,
          a.workspace,
          a.benched ? 1 : 0,
          now(),
          a.permission_level,
          a.avatar_data,
        ],
      );
      store.run(
        "INSERT INTO conversations(id,agent_id,name,created_at,updated_at) VALUES(?,?,?,?,?)",
        [cid, aid, a.name, now(), now()],
      );
    });
    changed();
    res.json({ id: aid, conversationId: cid });
  });
  app.put("/api/agents/:id", (req, res) => {
    must("agents", req.params.id);
    const a = agentSchema.parse(req.body);
    a.workspace = workspace(a.workspace);
    if (
      engine.active.size &&
      [...engine.active.values()].some((r) => r.owner === req.params.id)
    )
      throw new Error(
        "Stop this worker’s current work before changing its profile.",
      );
    store.transaction(() => {
      store.run(
        "UPDATE agents SET name=?,role=?,description=?,instructions=?,color=?,provider=?,workspace=?,benched=?,permission_level=?,avatar_data=? WHERE id=?",
        [
          a.name,
          a.role,
          a.description,
          a.instructions,
          a.color,
          a.provider,
          a.workspace,
          a.benched ? 1 : 0,
          a.permission_level,
          a.avatar_data,
          req.params.id,
        ],
      );
      store.run("UPDATE conversations SET name=? WHERE agent_id=?", [
        a.name,
        req.params.id,
      ]);
    });
    changed();
    res.json({ ok: true });
  });
  app.delete("/api/agents/:id", (req, res) => {
    must("agents", req.params.id);
    if ([...engine.active.values()].some((r) => r.owner === req.params.id))
      throw new Error("Stop this worker’s active work before removing it.");
    for (const t of store.all(
      "SELECT id FROM tasks WHERE owner_id=? AND status IN ('queued','waiting_dependency')",
      [req.params.id],
    ))
      engine.cancel(t.id);
    store.run("DELETE FROM agents WHERE id=?", [req.params.id]);
    changed();
    res.json({ ok: true });
  });
  const saveTeam = (req, res, existing) => {
    const t = teamSchema.parse(req.body);
    t.workspace = workspace(t.workspace);
    t.members = [...new Set(t.members)];
    t.members.forEach((a) => must("agents", a));
    const tid = existing || id();
    if (existing) {
      must("teams", tid);
      store.run("UPDATE teams SET name=?,objective=?,workspace=? WHERE id=?", [
        t.name,
        t.objective,
        t.workspace,
        tid,
      ]);
      store.run("DELETE FROM team_members WHERE team_id=?", [tid]);
      store.run("UPDATE conversations SET name=? WHERE team_id=?", [
        t.name,
        tid,
      ]);
    } else
      store.run("INSERT INTO teams VALUES(?,?,?,?,?)", [
        tid,
        t.name,
        t.objective,
        t.workspace,
        now(),
      ]);
    for (const aid of t.members)
      store.run("INSERT INTO team_members VALUES(?,?)", [tid, aid]);
    let conv = store.one("SELECT id FROM conversations WHERE team_id=?", [tid]);
    if (!conv) {
      conv = { id: id() };
      store.run(
        "INSERT INTO conversations(id,team_id,name,created_at,updated_at) VALUES(?,?,?,?,?)",
        [conv.id, tid, t.name, now(), now()],
      );
    }
    changed();
    res.json({ id: tid, conversationId: conv.id });
  };
  app.post("/api/teams", (req, res) => saveTeam(req, res));
  app.put("/api/teams/:id", (req, res) => saveTeam(req, res, req.params.id));
  app.get("/api/conversations/:id/messages", (req, res) => {
    const before = req.query.before
      ? z.string().uuid().parse(req.query.before)
      : null;
    let cursor = Number.MAX_SAFE_INTEGER;
    if (before) {
      const m = must("messages", before);
      if (m.conversation_id !== req.params.id)
        throw new Error("Message cursor belongs to another conversation.");
      cursor = store.one("SELECT rowid FROM messages WHERE id=?", [
        before,
      ]).rowid;
    }
    const rows = store
      .all(
        "SELECT * FROM messages WHERE conversation_id=? AND rowid<? ORDER BY rowid DESC LIMIT 100",
        [req.params.id, cursor],
      )
      .reverse();
    const attachments = store.all(
      "SELECT id,message_id,name,size FROM attachments WHERE conversation_id=?",
      [req.params.id],
    );
    const reactions = store.all(
      `SELECT r.message_id,r.emoji FROM message_reactions r JOIN messages m ON m.id=r.message_id WHERE m.conversation_id=?`,
      [req.params.id],
    );
    res.json(
      rows.map((m) => ({
        ...m,
        attachments: attachments.filter((a) => a.message_id === m.id),
        reactions: reactions
          .filter((r) => r.message_id === m.id)
          .map((r) => r.emoji),
      })),
    );
  });
  app.post("/api/messages/:id/reactions", (req, res) => {
    must("messages", req.params.id);
    const emoji = z.string().trim().min(1).max(16).parse(req.body.emoji);
    const existing = store.one(
      "SELECT id FROM message_reactions WHERE message_id=? AND emoji=?",
      [req.params.id, emoji],
    );
    if (existing)
      store.run("DELETE FROM message_reactions WHERE id=?", [existing.id]);
    else
      store.run("INSERT INTO message_reactions VALUES(?,?,?,?)", [
        id(),
        req.params.id,
        emoji,
        now(),
      ]);
    changed();
    res.json({ active: !existing });
  });
  app.patch("/api/conversations/:id", (req, res) => {
    must("conversations", req.params.id);
    const body = z
      .object({
        pinned: z.boolean().optional(),
        archived: z.boolean().optional(),
        muted: z.boolean().optional(),
        read: z.boolean().optional(),
        markUnread: z.boolean().optional(),
      })
      .parse(req.body);
    if (body.pinned !== undefined)
      store.run("UPDATE conversations SET pinned=? WHERE id=?", [
        body.pinned ? 1 : 0,
        req.params.id,
      ]);
    if (body.archived !== undefined)
      store.run("UPDATE conversations SET archived=? WHERE id=?", [
        body.archived ? 1 : 0,
        req.params.id,
      ]);
    if (body.muted !== undefined)
      store.run("UPDATE conversations SET muted=? WHERE id=?", [
        body.muted ? 1 : 0,
        req.params.id,
      ]);
    if (body.read)
      store.run("UPDATE conversations SET read_at=? WHERE id=?", [
        now(),
        req.params.id,
      ]);
    if (body.markUnread)
      store.run("UPDATE conversations SET read_at='' WHERE id=?", [
        req.params.id,
      ]);
    changed();
    res.json({ ok: true });
  });
  app.post("/api/conversations/:id/messages", (req, res) => {
    const c = must("conversations", req.params.id);
    const body = z
      .object({
        content: z.string().trim().min(1).max(24000),
        replyTo: z.string().uuid().nullable().optional(),
        attachments: z
          .array(z.object({ name: short, content: z.string().max(200000) }))
          .max(5)
          .default([]),
      })
      .parse(req.body);
    if (body.replyTo && must("messages", body.replyTo).conversation_id !== c.id)
      throw new Error("Reply must belong to this chat.");
    const mid = engine.message(
      c.id,
      "user",
      body.content,
      null,
      "text",
      "complete",
      body.replyTo || null,
    );
    for (const a of body.attachments)
      store.run("INSERT INTO attachments VALUES(?,?,?,?,?,?,?)", [
        id(),
        c.id,
        mid,
        a.name,
        a.content,
        Buffer.byteLength(a.content),
        now(),
      ]);
    const activeHandling = engine.steer(c.id, mid, body.content);
    if (activeHandling) {
      res.json({ id: mid, handling: activeHandling });
      return;
    }
    engine.route(c, body.content, mid);
    res.json({ id: mid });
  });
  app.post("/api/conversations/:id/stop", (req, res) => {
    engine.stopConversation(req.params.id);
    res.json({ ok: true });
  });
  app.get("/api/tasks/:id", (req, res) =>
    res.json({
      task: must("tasks", req.params.id),
      events: store.all(
        "SELECT * FROM events WHERE task_id=? ORDER BY created_at",
        [req.params.id],
      ),
      dependencies: store.all(
        "SELECT t.* FROM tasks t JOIN task_dependencies d ON t.id=d.depends_on WHERE d.task_id=?",
        [req.params.id],
      ),
      outcome: store.one("SELECT * FROM outcome_contracts WHERE task_id=?", [
        req.params.id,
      ]),
      criteria: store.all(
        "SELECT c.* FROM acceptance_criteria c JOIN outcome_contracts o ON o.id=c.outcome_id WHERE o.task_id=? ORDER BY c.created_at",
        [req.params.id],
      ),
      evidence: store.all(
        "SELECT * FROM evidence WHERE task_id=? ORDER BY created_at",
        [req.params.id],
      ),
      review: store.one("SELECT * FROM review_verdicts WHERE task_id=?", [
        req.params.id,
      ]),
      receipt: store.one("SELECT * FROM work_receipts WHERE task_id=?", [
        req.params.id,
      ]),
      githubOwnership: store.all(
        "SELECT * FROM github_ownership WHERE task_id=? ORDER BY updated_at DESC",
        [req.params.id],
      ),
    }),
  );
  app.get("/api/tasks/:id/inspection", async (req, res) => {
    const task = must("tasks", req.params.id);
    try {
      res.json(await taskInspection(task));
    } catch {
      res.json({
        available: false,
        reason: "Git changes are available for Git project folders.",
      });
    }
  });
  app.get("/api/tasks/:id/browser-checks", (req, res) => {
    const task = must("tasks", req.params.id);
    res.json({
      scripts: detectedBrowserScripts(task.worktree_path || task.workspace),
    });
  });
  app.post("/api/tasks/:id/browser-check", async (req, res) => {
    const task = must("tasks", req.params.id);
    if (task.status !== "completed")
      throw new Error("Complete the work before running browser verification.");
    const owner = task.owner_id ? must("agents", task.owner_id) : null;
    if (owner?.permission_level === "read_only")
      throw new Error(
        "This worker is read-only and cannot run a browser check.",
      );
    const { script } = z
      .object({ script: z.string().trim().min(1).max(100) })
      .parse(req.body);
    const result = await runBrowserScript(task, script);
    const outcome = store.one(
      "SELECT * FROM outcome_contracts WHERE task_id=?",
      [task.id],
    );
    const evidenceId = id();
    store.transaction(() => {
      const artifactId = id();
      store.run(
        "INSERT INTO artifacts(id,task_id,conversation_id,name,content,size,created_at) VALUES(?,?,?,?,?,?,?)",
        [
          artifactId,
          task.id,
          task.conversation_id,
          `${script} browser verification.txt`,
          result.output,
          Buffer.byteLength(result.output),
          now(),
        ],
      );
      if (outcome) {
        let criterion = store.one(
          "SELECT * FROM acceptance_criteria WHERE outcome_id=? AND type='browser' AND command=?",
          [outcome.id, result.command],
        );
        if (!criterion) {
          store.run(
            "INSERT INTO acceptance_criteria(id,outcome_id,type,description,command,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            [
              id(),
              outcome.id,
              "browser",
              `Browser verification: ${script}`,
              result.command,
              now(),
              now(),
            ],
          );
          criterion = store.one(
            "SELECT * FROM acceptance_criteria WHERE outcome_id=? AND type='browser' AND command=?",
            [outcome.id, result.command],
          );
          store.run(
            "UPDATE outcome_contracts SET status='verifying',updated_at=? WHERE id=?",
            [now(), outcome.id],
          );
          store.run("UPDATE tasks SET verification='unverified' WHERE id=?", [
            task.id,
          ]);
          store.run("DELETE FROM work_receipts WHERE task_id=?", [task.id]);
        }
        store.run(
          "INSERT INTO evidence(id,task_id,outcome_id,type,source,status,summary,artifact_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
          [
            evidenceId,
            task.id,
            outcome.id,
            "browser",
            `Browser script: ${script}`,
            result.status,
            result.summary,
            artifactId,
            now(),
          ],
        );
        store.run(
          "UPDATE acceptance_criteria SET status=?,evidence_id=?,updated_at=? WHERE id=?",
          [result.status, evidenceId, now(), criterion.id],
        );
        if (result.status === "pass") settleOutcome(outcome, result.summary);
        else
          store.run(
            "UPDATE outcome_contracts SET status='verifying',updated_at=? WHERE id=?",
            [now(), outcome.id],
          );
      }
    });
    engine.event(task.id, "browser.verification", result.summary);
    changed();
    res.json({ ...result, evidenceId });
  });
  app.post("/api/tasks/:id/coderabbit-review", async (req, res) => {
    const task = must("tasks", req.params.id);
    if (task.kind !== "work" || task.status !== "completed")
      throw new Error(
        "Complete a coding task before requesting CodeRabbit review.",
      );
    if (!task.worktree_path)
      throw new Error(
        "CodeRabbit review requires this task's isolated worktree.",
      );
    const integration = store.one(
      "SELECT * FROM integrations WHERE provider='coderabbit'",
    );
    if (
      !integration ||
      !["available", "connected"].includes(integration.status)
    )
      throw new Error(
        "Connect the local CodeRabbit CLI before requesting review.",
      );
    const scopes = JSON.parse(integration.workspace_scope_json || "[]");
    if (scopes.length && !scopes.includes(task.workspace))
      throw new Error("CodeRabbit is not allowed for this task's project.");
    const review = await runCodeRabbitReview(task, integrationCommand);
    const outcome = store.one(
      "SELECT id FROM outcome_contracts WHERE task_id=?",
      [task.id],
    );
    const artifactId = id();
    const evidenceId = id();
    const artifactContent = JSON.stringify(
      {
        summary: review.summary,
        findings: review.findings,
        records: review.records,
        output: review.output,
      },
      null,
      2,
    );
    store.transaction(() => {
      store.run(
        "INSERT INTO artifacts(id,task_id,conversation_id,name,content,size,created_at) VALUES(?,?,?,?,?,?,?)",
        [
          artifactId,
          task.id,
          task.conversation_id,
          "CodeRabbit independent review.json",
          artifactContent,
          Buffer.byteLength(artifactContent),
          now(),
        ],
      );
      store.run(
        "INSERT INTO evidence(id,task_id,outcome_id,type,source,status,summary,artifact_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        [
          evidenceId,
          task.id,
          outcome?.id || null,
          "external_review",
          "CodeRabbit CLI",
          "observed",
          review.summary,
          artifactId,
          now(),
        ],
      );
    });
    engine.event(task.id, "coderabbit.review", review.summary);
    changed();
    res.json({ evidenceId, artifactId, summary: review.summary });
  });
  app.get("/api/tasks/:id/receipt", (req, res) => {
    const task = must("tasks", req.params.id);
    const receipt = store.one("SELECT * FROM work_receipts WHERE task_id=?", [
      task.id,
    ]);
    if (!receipt)
      throw new Error("This task does not have a verified work receipt yet.");
    const filename = `${task.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").slice(0, 70) || "Roster receipt"}.md`;
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.send(receipt.content);
  });
  app.post("/api/tasks/:id/cancel", (req, res) => {
    engine.cancel(req.params.id);
    res.json({ ok: true });
  });
  app.post("/api/tasks/:id/retry", (req, res) => {
    engine.retry(req.params.id);
    res.json({ ok: true });
  });
  app.post("/api/tasks/:id/integration-ready", async (req, res) => {
    const task = must("tasks", req.params.id);
    if (task.kind !== "work" || task.status !== "completed")
      throw new Error("Complete a coding task before preparing its handoff.");
    const inspection = await taskInspection(task);
    if (!inspection.available || !inspection.diff)
      throw new Error("No task-scoped Git change is ready to hand off.");
    const integration = await integrationCheck(task, inspection.diff);
    const artifactId = id();
    const filename = `${task.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").slice(0, 70) || "Roster work"}.patch`;
    store.transaction(() => {
      store.run("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)", [
        artifactId,
        task.id,
        task.conversation_id,
        filename,
        inspection.diff,
        Buffer.byteLength(inspection.diff),
        now(),
      ]);
      store.run(
        "INSERT INTO attention_items(id,task_id,type,title,detail,action_json,created_at) VALUES(?,?,?,?,?,?,?)",
        [
          id(),
          task.id,
          integration.status === "ready"
            ? "integration"
            : "integration_conflict",
          integration.status === "ready"
            ? "Work is ready to integrate"
            : "Work needs integration help",
          integration.status === "ready"
            ? "The task-scoped patch applies cleanly. Review it before applying it to your checkout."
            : integration.detail,
          JSON.stringify({ artifactId, integration }),
          now(),
        ],
      );
    });
    engine.event(task.id, "integration.ready", integration.detail);
    res.json({ artifactId, integration });
  });
  app.post("/api/tasks/:id/verify", (req, res) => {
    const t = must("tasks", req.params.id);
    if (t.status !== "completed")
      throw new Error("Complete the work before verifying it.");
    const b = z
      .object({ evidence: z.string().trim().min(10).max(3000) })
      .parse(req.body);
    const outcome = store.one(
      "SELECT * FROM outcome_contracts WHERE task_id=?",
      [t.id],
    );
    store.transaction(() => {
      store.run("UPDATE tasks SET verification='verified' WHERE id=?", [t.id]);
      if (outcome) {
        const evidenceId = id();
        store.run(
          "INSERT INTO evidence(id,task_id,outcome_id,type,source,status,summary,created_at) VALUES(?,?,?,?,?,?,?,?)",
          [
            evidenceId,
            t.id,
            outcome.id,
            "manual",
            "user",
            "pass",
            b.evidence,
            now(),
          ],
        );
        store.run(
          "UPDATE acceptance_criteria SET status='pass',evidence_id=?,updated_at=? WHERE outcome_id=? AND type='manual' AND status='pending'",
          [evidenceId, now(), outcome.id],
        );
        settleOutcome(outcome, b.evidence);
      }
    });
    engine.event(t.id, "verification.confirmed", {
      source: "user",
      evidence: b.evidence,
    });
    changed();
    res.json({ ok: true });
  });
  app.post("/api/outcomes/:id/criteria", (req, res) => {
    const outcome = must("outcome_contracts", req.params.id);
    const body = z
      .object({
        type: z.enum([
          "manual",
          "command",
          "test",
          "build",
          "review",
          "browser",
          "github_ci",
          "deployment",
          "sentry",
          "external_tool",
        ]),
        description: z.string().trim().min(3).max(1000),
        command: z.string().trim().max(2000).default(""),
      })
      .parse(req.body);
    store.run(
      "INSERT INTO acceptance_criteria(id,outcome_id,type,description,command,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      [
        id(),
        outcome.id,
        body.type,
        body.description,
        body.command,
        now(),
        now(),
      ],
    );
    store.transaction(() => {
      store.run(
        "UPDATE outcome_contracts SET status='verifying',updated_at=? WHERE id=?",
        [now(), outcome.id],
      );
      store.run("UPDATE tasks SET verification='unverified' WHERE id=?", [
        outcome.task_id,
      ]);
      store.run("DELETE FROM work_receipts WHERE task_id=?", [outcome.task_id]);
    });
    changed();
    res.json({ ok: true });
  });
  app.post("/api/criteria/:id/record", (req, res) => {
    const criterion = must("acceptance_criteria", req.params.id);
    if (criterion.type === "review")
      throw new Error(
        "Independent review criteria are completed only by a reviewer verdict.",
      );
    const body = z
      .object({
        status: z.enum(["pass", "fail"]),
        evidence: z.string().trim().min(3).max(3000),
      })
      .parse(req.body);
    const outcome = must("outcome_contracts", criterion.outcome_id);
    const evidenceId = id();
    store.transaction(() => {
      store.run(
        "INSERT INTO evidence(id,task_id,outcome_id,type,source,status,summary,created_at) VALUES(?,?,?,?,?,?,?,?)",
        [
          evidenceId,
          outcome.task_id,
          outcome.id,
          criterion.type,
          "user",
          body.status,
          body.evidence,
          now(),
        ],
      );
      store.run(
        "UPDATE acceptance_criteria SET status=?,evidence_id=?,updated_at=? WHERE id=?",
        [body.status, evidenceId, now(), criterion.id],
      );
      settleOutcome(outcome, body.evidence);
    });
    changed();
    res.json({ ok: true });
  });
  app.post("/api/approvals/:id", (req, res) => {
    const { allow } = z.object({ allow: z.boolean() }).parse(req.body);
    engine.resolveApproval(req.params.id, allow);
    res.json({ ok: true });
  });
  app.post("/api/attention/:id/resolve", (req, res) => {
    const item = must("attention_items", req.params.id);
    if (item.status !== "open")
      throw new Error("This item is already resolved.");
    store.run(
      "UPDATE attention_items SET status='resolved',resolved_at=? WHERE id=?",
      [now(), item.id],
    );
    if (item.task_id)
      engine.event(
        item.task_id,
        "attention.resolved",
        "Marked resolved by you.",
      );
    changed();
    res.json({ ok: true });
  });
  app.post("/api/attention/:id/repair", (req, res) => {
    const item = must("attention_items", req.params.id);
    if (
      item.status !== "open" ||
      !item.type.match(/^github_(ci|review|conflict|closed)$/)
    )
      throw new Error("This item does not have an automatic repair path.");
    const repair = engine.repairGithub(item.task_id, item.detail);
    store.run(
      "UPDATE attention_items SET status='resolved',resolved_at=? WHERE id=?",
      [now(), item.id],
    );
    changed();
    res.json(repair);
  });
  app.post("/api/memories", (req, res) => {
    const b = z
      .object({
        scopeId: z.string().uuid(),
        content: z.string().trim().min(1).max(4000),
      })
      .parse(req.body);
    if (
      !store.one("SELECT id FROM agents WHERE id=?", [b.scopeId]) &&
      !store.one("SELECT id FROM teams WHERE id=?", [b.scopeId])
    )
      throw new Error("Worker or team no longer exists.");
    const mid = id();
    store.run("INSERT INTO memories VALUES(?,?,?,?)", [
      mid,
      b.scopeId,
      b.content,
      now(),
    ]);
    changed();
    res.json({ id: mid });
  });
  app.put("/api/memories/:id", (req, res) => {
    const b = z
      .object({ content: z.string().trim().min(1).max(4000) })
      .parse(req.body);
    must("memories", req.params.id);
    store.run("UPDATE memories SET content=? WHERE id=?", [
      b.content,
      req.params.id,
    ]);
    changed();
    res.json({ ok: true });
  });
  app.delete("/api/memories/:id", (req, res) => {
    store.run("DELETE FROM memories WHERE id=?", [req.params.id]);
    changed();
    res.json({ ok: true });
  });
  app.get("/api/files", (req, res) =>
    res.json(
      store.all(
        "SELECT id,name,size,conversation_id,message_id,created_at,'attachment' kind FROM attachments UNION ALL SELECT id,name,size,conversation_id,NULL message_id,created_at,'result' kind FROM artifacts ORDER BY created_at DESC",
      ),
    ),
  );
  app.get("/api/files/:id", (req, res) => {
    const a =
      store.one("SELECT * FROM attachments WHERE id=?", [req.params.id]) ||
      store.one("SELECT * FROM artifacts WHERE id=?", [req.params.id]);
    if (!a) throw new Error("This file no longer exists.");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,
    );
    res.type("text/plain").send(a.content);
  });
  app.get("/api/activity", (req, res) =>
    res.json(
      store.all(
        "SELECT e.*,t.title FROM events e LEFT JOIN tasks t ON t.id=e.task_id ORDER BY created_at DESC LIMIT 200",
      ),
    ),
  );
  app.get("/api/digest/weekly", (req, res) => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const outcomes = store.all(
      `SELECT t.id,t.title,t.completed_at,r.content receipt,
        (SELECT COUNT(*) FROM evidence e WHERE e.task_id=t.id AND e.status='pass') evidence_count
       FROM tasks t LEFT JOIN work_receipts r ON r.task_id=t.id
       WHERE t.verification='verified' AND t.completed_at>=? ORDER BY t.completed_at DESC`,
      [since],
    );
    res.json({ since, outcomes, verifiedCount: outcomes.length });
  });
  app.get("/api/digest/weekly/receipt", (req, res) => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const outcomes = store.all(
      `SELECT t.title,t.completed_at,
        (SELECT COUNT(*) FROM evidence e WHERE e.task_id=t.id AND e.status='pass') evidence_count
       FROM tasks t
       WHERE t.verification='verified' AND t.completed_at>=? ORDER BY t.completed_at DESC`,
      [since],
    );
    const receipt = [
      "# Roster weekly receipt",
      "",
      `Period: ${new Date(since).toLocaleDateString()} to ${new Date().toLocaleDateString()}`,
      "",
      `Verified outcomes: ${outcomes.length}`,
      "",
      ...(outcomes.length
        ? outcomes.flatMap((outcome) => [
            `## ${outcome.title}`,
            "",
            `Completed: ${new Date(outcome.completed_at).toLocaleString()}`,
            `Passing evidence: ${outcome.evidence_count}`,
            "",
          ])
        : ["No verified outcomes were recorded during this period.", ""]),
    ].join("\n");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=Roster-weekly-receipt.md",
    );
    res.type("text/markdown").send(receipt);
  });
  app.get("/api/search", (req, res) => {
    const q = z
      .string()
      .max(200)
      .parse(req.query.q || "");
    res.json(
      store.all(
        "SELECT m.*,c.name FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.content LIKE ? ORDER BY m.created_at DESC LIMIT 50",
        ["%" + q + "%"],
      ),
    );
  });
  app.post("/api/settings", (req, res) => {
    const b = z
      .object({
        theme: z.enum(["light", "dark", "system"]).optional(),
        wallpaper: z.enum(["classic", "paper", "plain"]).optional(),
        parallelLimit: z.number().int().min(1).max(4).optional(),
        repairLimit: z.number().int().min(1).max(5).optional(),
        workspaceName: short.optional(),
        compatible: z
          .object({ name: short, endpoint: z.string().url(), model: short })
          .nullable()
          .optional(),
        apiKey: z.string().max(1000).optional(),
      })
      .parse(req.body);
    if (b.compatible) {
      const u = new URL(b.compatible.endpoint);
      if (
        u.protocol !== "https:" &&
        !(
          u.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
        )
      )
        throw new Error(
          "Use HTTPS for remote providers, or HTTP for a local provider.",
        );
      if (u.username || u.password || u.search || u.hash)
        throw new Error(
          "Endpoint must not contain credentials, queries or fragments.",
        );
    }
    if (b.apiKey !== undefined) {
      if (!vault)
        throw new Error(
          "Save keys in the desktop app, or use OPENAI_API_KEY in the environment.",
        );
      vault.set(b.apiKey);
      const endpoint = (b.compatible || store.setting("compatible"))?.endpoint;
      store.setSetting(
        "keyOrigin",
        b.apiKey && endpoint ? new URL(endpoint).origin : null,
      );
    }
    if (b.compatible === null) {
      vault?.set("");
      store.setSetting("keyOrigin", null);
    }
    for (const [key, value] of Object.entries(b))
      if (key !== "apiKey") store.setSetting(key, value);
    changed();
    res.json({ ok: true });
    void engine.detect().catch(() => {});
  });
  app.post("/api/providers/detect", async (req, res) =>
    res.json(await engine.detect()),
  );
  app.post("/api/providers/test", async (req, res) => {
    const b = z
      .object({ provider: z.enum(["codex", "claude", "compatible"]) })
      .parse(req.body);
    const { runCodex, runClaude, runCompatible } =
      await import("./runtime.mjs");
    const scratch = path.join(directory, "connection-test");
    fs.mkdirSync(scratch, { recursive: true });
    const result =
      b.provider === "codex"
        ? await runCodex({
            prompt:
              "Reply with exactly: Roster is connected. Do not use tools.",
            cwd: scratch,
            readOnly: true,
          })
        : b.provider === "claude"
          ? await runClaude({
              prompt: "Reply with exactly: Roster connection confirmed.",
              cwd: scratch,
              signal: AbortSignal.timeout(90000),
              readOnly: true,
            })
          : await runCompatible({
              prompt: "Reply with exactly: Roster is connected.",
              config: store.setting("compatible") || {},
              key: providerKey(store, vault),
            });
    if (b.provider === "claude") {
      store.setSetting("claudeVerified", true);
      await engine.detect();
    }
    res.json({ message: result.text });
  });
  app.use(express.static(path.join(root, "dist")));
  app.get("/{*path}", (req, res) =>
    res.sendFile(path.join(root, "dist", "index.html")),
  );
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(400).json({
      error:
        error instanceof z.ZodError
          ? error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")
          : cleanError(error),
    });
  });
  let server;
  try {
    server = await new Promise((resolve, reject) => {
      const s = app.listen(port, "127.0.0.1", () => resolve(s));
      s.on("error", reject);
    });
  } catch (error) {
    clearInterval(heartbeat);
    await engine.close();
    store.close();
    releaseLock();
    throw error;
  }
  engine.detect().catch(() => {});
  refreshIntegrations(store, vault, { fetchFn: integrationFetch })
    .then(() => {
      reconcileIntegrationAttention();
      changed();
    })
    .catch(() => {});
  const integrationHeartbeat = setInterval(
    () => {
      const before = JSON.stringify(
        store.all(
          "SELECT provider,status,detail FROM integrations ORDER BY provider",
        ),
      );
      refreshIntegrations(store, vault, { fetchFn: integrationFetch })
        .then(() => {
          reconcileIntegrationAttention();
          return monitorSentryIssues();
        })
        .then(() => {
          const after = JSON.stringify(
            store.all(
              "SELECT provider,status,detail FROM integrations ORDER BY provider",
            ),
          );
          if (before !== after) changed();
        })
        .catch(() => {});
    },
    5 * 60 * 1000,
  );
  integrationHeartbeat.unref();
  const githubHeartbeat = setInterval(() => {
    githubOwnership
      .refresh()
      .then((ownership) => ownership.length && changed())
      .catch(() => {});
  }, 60000);
  githubHeartbeat.unref();
  return {
    app,
    server,
    store,
    engine,
    snapshot,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      clearInterval(heartbeat);
      clearInterval(integrationHeartbeat);
      clearInterval(githubHeartbeat);
      await engine.close();
      for (const res of clients) res.end();
      await new Promise((r) => server.close(r));
      store.close();
      releaseLock();
    },
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.loadEnvFile) {
    try {
      process.loadEnvFile(".env");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const service = await createServer();
  console.log(`Roster is ready at ${service.url}`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await service.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
