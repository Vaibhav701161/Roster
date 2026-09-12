import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { id, now } from "./store.mjs";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const catalog = [
  {
    provider: "github",
    name: "GitHub",
    type: "cli",
    capabilities: [
      "repositories",
      "issues",
      "pull_requests",
      "actions",
      "checks",
    ],
    tools: [
      [
        "repository.read",
        "Read repository and pull request context",
        "read",
        "github.read",
        "github_check",
      ],
    ],
  },
  {
    provider: "playwright",
    name: "Playwright",
    type: "cli",
    capabilities: ["browser_verification", "screenshots", "traces"],
    tools: [
      [
        "verify.browser",
        "Run browser checks and retain artifacts",
        "reversible_write",
        "browser",
        "screenshot",
      ],
    ],
  },
  {
    provider: "sentry",
    name: "Sentry",
    type: "native",
    capabilities: ["issues", "releases", "errors"],
    tools: [
      ["issues.read", "Read error context", "read", "sentry.read", "sentry"],
    ],
  },
  {
    provider: "vercel",
    name: "Vercel",
    type: "cli",
    capabilities: ["deployments", "builds"],
    tools: [
      [
        "deployments.read",
        "Read deployment state",
        "read",
        "deployment.read",
        "deployment",
      ],
    ],
  },
  {
    provider: "coderabbit",
    name: "CodeRabbit",
    type: "cli",
    capabilities: ["pull_request_review"],
    tools: [
      [
        "review.read",
        "Read independent code review findings",
        "read",
        "github.read",
        "external_review",
      ],
    ],
  },
  {
    provider: "linear",
    name: "Linear",
    type: "native",
    capabilities: ["issues", "projects"],
    tools: [
      [
        "issues.read",
        "Read planning context",
        "read",
        "linear.read",
        "external_tool",
      ],
    ],
  },
  {
    provider: "supabase",
    name: "Supabase",
    type: "cli",
    capabilities: ["database", "migrations", "logs"],
    tools: [
      [
        "projects.read",
        "Read project context",
        "read",
        "database.read",
        "external_tool",
      ],
    ],
  },
  {
    provider: "slack",
    name: "Slack",
    type: "native",
    capabilities: ["messages", "channels"],
    tools: [
      [
        "messages.read",
        "Read linked delivery context",
        "read",
        "slack.read",
        "external_tool",
      ],
    ],
  },
  {
    provider: "notion",
    name: "Notion",
    type: "native",
    capabilities: ["pages", "decisions"],
    tools: [
      [
        "pages.read",
        "Read linked project decisions",
        "read",
        "notion.read",
        "external_tool",
      ],
    ],
  },
];

async function commandStatus(command, args = ["--version"]) {
  try {
    await exec(command, args, { windowsHide: true, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function detect(entry) {
  if (entry.provider === "github") {
    if (!(await commandStatus("gh")))
      return {
        status: "unavailable",
        detail: "Install GitHub CLI to connect GitHub.",
      };
    return (await commandStatus("gh", ["auth", "status"]))
      ? {
          status: "connected",
          detail: "GitHub CLI is authenticated for this desktop account.",
        }
      : {
          status: "authentication_required",
          detail: "Run gh auth login to connect GitHub.",
        };
  }
  if (entry.provider === "playwright") {
    try {
      require.resolve("playwright");
      return {
        status: "available",
        detail: "Playwright is installed locally for browser verification.",
      };
    } catch {
      return {
        status: "unavailable",
        detail: "Install Playwright locally to enable browser verification.",
      };
    }
  }
  const commands = {
    vercel: "vercel",
    coderabbit: "coderabbit",
    supabase: "supabase",
  };
  if (commands[entry.provider])
    return (await commandStatus(commands[entry.provider]))
      ? {
          status: "available",
          detail: `${entry.name} CLI is installed. Connect an account to enable it.`,
        }
      : {
          status: "unavailable",
          detail: `${entry.name} requires its local CLI and an authenticated account.`,
        };
  return {
    status: "authentication_required",
    detail: `${entry.name} requires a connected account before Roster can use it.`,
  };
}

export async function refreshIntegrations(store) {
  const results = await Promise.all(
    catalog.map(async (entry) => ({ entry, state: await detect(entry) })),
  );
  store.transaction(() => {
    for (const { entry, state } of results) {
      const existing = store.one(
        "SELECT id FROM integrations WHERE provider=?",
        [entry.provider],
      );
      const integrationId = existing?.id || id();
      store.run(
        "INSERT INTO integrations(id,provider,name,type,status,detail,capabilities_json,risk_policy_json,workspace_scope_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET name=excluded.name,type=excluded.type,status=excluded.status,detail=excluded.detail,capabilities_json=excluded.capabilities_json,updated_at=excluded.updated_at",
        [
          integrationId,
          entry.provider,
          entry.name,
          entry.type,
          state.status,
          state.detail,
          JSON.stringify(entry.capabilities),
          JSON.stringify({
            read: "allowed",
            reversible_write: "approval_required",
            external_side_effect: "approval_required",
            high_risk: "approval_required",
          }),
          "[]",
          now(),
        ],
      );
      for (const [
        name,
        description,
        risk,
        permission,
        evidenceType,
      ] of entry.tools)
        store.run(
          "INSERT INTO integration_tools(id,integration_id,name,description,risk,required_permissions_json,evidence_type) VALUES(?,?,?,?,?,?,?) ON CONFLICT(integration_id,name) DO UPDATE SET description=excluded.description,risk=excluded.risk,required_permissions_json=excluded.required_permissions_json,evidence_type=excluded.evidence_type",
          [
            id(),
            integrationId,
            name,
            description,
            risk,
            JSON.stringify([permission]),
            evidenceType,
          ],
        );
    }
  });
  return store.all("SELECT * FROM integrations ORDER BY name");
}
