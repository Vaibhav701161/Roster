import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { id, now } from "./store.mjs";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const tokenKey = (provider) => `integration:${provider}:token`;
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

const tokenProviders = {
  sentry: {
    endpoint: "https://sentry.io/api/0/",
    headers: () => ({}),
    valid: (response) => response.ok,
    name: "Sentry",
  },
  linear: {
    endpoint: "https://api.linear.app/graphql",
    method: "POST",
    headers: () => ({ "Content-Type": "application/json" }),
    body: JSON.stringify({ query: "query RosterViewer { viewer { id } }" }),
    valid: (response, payload) => response.ok && !!payload?.data?.viewer?.id,
    name: "Linear",
  },
  slack: {
    endpoint: "https://slack.com/api/auth.test",
    headers: () => ({}),
    valid: (response, payload) => response.ok && payload?.ok === true,
    name: "Slack",
  },
  notion: {
    endpoint: "https://api.notion.com/v1/users/me",
    headers: () => ({ "Notion-Version": "2022-06-28" }),
    valid: (response) => response.ok,
    name: "Notion",
  },
};

function namedSecret(vault, provider) {
  return vault?.getNamed?.(tokenKey(provider)) || "";
}

async function probeTokenProvider(provider, token, fetchFn = fetch) {
  const config = tokenProviders[provider];
  if (!config) return null;
  if (!token)
    return {
      status: "authentication_required",
      detail: `Add a ${config.name} access token to connect this desktop.`,
    };
  try {
    const response = await fetchFn(config.endpoint, {
      method: config.method || "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...config.headers(),
      },
      ...(config.body ? { body: config.body } : {}),
      signal: AbortSignal.timeout(7000),
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // A successful account probe does not require a response body.
    }
    if (config.valid(response, payload))
      return {
        status: "connected",
        detail: `${config.name} access token is connected for this desktop.`,
      };
    return {
      status: "authentication_required",
      detail: `${config.name} rejected the saved access token. Update it to reconnect.`,
    };
  } catch {
    return {
      status: "unavailable",
      detail: `${config.name} could not be reached from this desktop. Try refreshing when it is online.`,
    };
  }
}

async function commandStatus(command, args = ["--version"]) {
  try {
    await exec(command, args, { windowsHide: true, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function commandOutput(command, args) {
  try {
    const { stdout } = await exec(command, args, {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 100000,
    });
    return String(stdout).trim();
  } catch {
    return "";
  }
}

export async function detectIntegration(entry, { vault, fetchFn } = {}) {
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
  if (entry.provider === "vercel") {
    if (!(await commandStatus("vercel")))
      return {
        status: "unavailable",
        detail: "Vercel requires its local CLI and an authenticated account.",
      };
    const account = await commandOutput("vercel", ["whoami"]);
    return account
      ? {
          status: "connected",
          detail: `Vercel CLI is authenticated as ${account.slice(0, 160)}.`,
        }
      : {
          status: "authentication_required",
          detail: "Run vercel login to connect Vercel.",
        };
  }
  if (entry.provider === "supabase") {
    if (!(await commandStatus("supabase")))
      return {
        status: "unavailable",
        detail: "Supabase requires its local CLI and an authenticated account.",
      };
    return (await commandOutput("supabase", ["projects", "list"]))
      ? {
          status: "connected",
          detail: "Supabase CLI is authenticated for this desktop account.",
        }
      : {
          status: "authentication_required",
          detail: "Run supabase login to connect Supabase.",
        };
  }
  if (tokenProviders[entry.provider])
    return probeTokenProvider(
      entry.provider,
      namedSecret(vault, entry.provider),
      fetchFn,
    );
  const commands = {
    coderabbit: "coderabbit",
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

export function integrationTokenConfigured(vault, provider) {
  return !!namedSecret(vault, provider);
}

export function saveIntegrationToken(vault, provider, token) {
  if (!tokenProviders[provider])
    throw new Error("This integration does not accept an access token.");
  if (!vault?.setNamed)
    throw new Error(
      "Secure credential storage is unavailable on this desktop.",
    );
  vault.setNamed(tokenKey(provider), token.trim());
}

export function supportsIntegrationToken(provider) {
  return !!tokenProviders[provider];
}

export async function refreshIntegrations(store, vault, options = {}) {
  const results = await Promise.all(
    catalog.map(async (entry) => ({
      entry,
      state: await detectIntegration(entry, { vault, ...options }),
    })),
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
