const full = {
  conversation: true,
  structuredOutput: true,
  filesystemRead: true,
  filesystemWrite: true,
  shell: true,
  git: true,
  webSearch: false,
  browser: false,
  approvals: true,
  sessionResume: true,
};

export const runtimeCapabilities = {
  codex: full,
  claude: full,
  compatible: {
    conversation: true,
    structuredOutput: false,
    filesystemRead: false,
    filesystemWrite: false,
    shell: false,
    git: false,
    webSearch: false,
    browser: false,
    approvals: false,
    sessionResume: false,
  },
  test: full,
};

export function taskRequirements({ kind, workspace }) {
  if (kind === "chat") return { conversation: true };
  if (kind === "review")
    return {
      conversation: true,
      filesystemRead: true,
      shell: true,
      git: true,
      structuredOutput: true,
    };
  if (workspace)
    return {
      conversation: true,
      filesystemRead: true,
      filesystemWrite: true,
      shell: true,
      git: true,
    };
  return { conversation: true };
}

export function supports(provider, requirements = {}) {
  const capabilities = runtimeCapabilities[provider];
  return (
    !!capabilities &&
    Object.entries(requirements).every(
      ([key, needed]) => !needed || capabilities[key],
    )
  );
}

export function missingCapabilities(provider, requirements = {}) {
  const capabilities = runtimeCapabilities[provider] || {};
  return Object.keys(requirements).filter(
    (key) => requirements[key] && !capabilities[key],
  );
}

export const permissionScopes = {
  read_only: ["filesystem.read", "shell.readonly", "git.read"],
  standard: [
    "filesystem.read",
    "filesystem.write",
    "shell.readonly",
    "shell.execute",
    "git.read",
    "git.branch",
  ],
  autonomous: [
    "filesystem.read",
    "filesystem.write",
    "shell.readonly",
    "shell.execute",
    "git.read",
    "git.branch",
    "git.commit",
  ],
};

export function providerPolicy(agent, kind) {
  const level = agent.permission_level || "standard";
  const readOnly = level === "read_only" || kind === "review";
  return {
    level,
    scopes: permissionScopes[level] || permissionScopes.standard,
    readOnly,
  };
}
