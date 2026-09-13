import fs from "node:fs";
import path from "node:path";
import { id, now } from "./store.mjs";

const instructionNames = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  ".github/copilot-instructions.md",
];
const existing = (workspace, name) => fs.existsSync(path.join(workspace, name));
function filesIn(workspace, directory, type) {
  const root = path.join(workspace, directory);
  if (!fs.existsSync(root)) return [];
  try {
    return fs
      .readdirSync(root, { recursive: true })
      .filter((name) => typeof name === "string")
      .slice(0, 40)
      .map((name) => ({
        type,
        path: path.join(directory, name).replaceAll("\\", "/"),
      }));
  } catch {
    return [];
  }
}

function commandFor(packageManager, script) {
  if (!script) return "";
  if (packageManager === "pnpm-lock.yaml") return `pnpm ${script}`;
  if (packageManager === "yarn.lock") return `yarn ${script}`;
  if (packageManager === "bun.lockb") return `bun run ${script}`;
  return `npm run ${script}`;
}

function setupFor(packageManager) {
  if (packageManager === "pnpm-lock.yaml")
    return ["pnpm install --frozen-lockfile"];
  if (packageManager === "yarn.lock") return ["yarn install --immutable"];
  if (packageManager === "bun.lockb") return ["bun install --frozen-lockfile"];
  if (packageManager === "package-lock.json") return ["npm ci"];
  return [];
}

function environmentFor(workspace, packageManager, scripts) {
  const byName = new Map(
    scripts.map((script) => [script.name, script.command]),
  );
  const command = (names) => names.find((name) => byName.has(name)) || "";
  const dev = command(["dev", "start", "serve"]);
  const test = command(["test", "test:unit", "check"]);
  const build = command(["build", "compile"]);
  const filesToCopy = [
    ".env.local",
    ".env.development.local",
    ".env.test.local",
  ].filter((name) => existing(workspace, name));
  const ciDirectory = path.join(workspace, ".github", "workflows");
  const ciFiles = fs.existsSync(ciDirectory)
    ? fs
        .readdirSync(ciDirectory)
        .filter((name) => /\.ya?ml$/i.test(name))
        .slice(0, 20)
    : [];
  const skillDirectories = [
    ".agents/skills",
    ".claude/skills",
    ".github/skills",
  ].filter((name) => existing(workspace, name));
  return {
    setup: setupFor(packageManager),
    filesToCopy,
    devCommand: commandFor(packageManager, dev),
    testCommand: commandFor(packageManager, test),
    buildCommand: commandFor(packageManager, build),
    detected: {
      docker: ["Dockerfile", "docker-compose.yml", "compose.yml"].filter(
        (name) => existing(workspace, name),
      ),
      readme: ["README.md", "README"].filter((name) =>
        existing(workspace, name),
      ),
      ci: ciFiles.map((name) => `.github/workflows/${name}`),
      skills: skillDirectories,
    },
  };
}

export function inspectProject(workspace) {
  const packageFile = path.join(workspace, "package.json");
  let packageJson = {};
  try {
    packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  } catch {
    // A project does not need a package manifest to be useful to Roster.
  }
  const lockfiles = [
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lockb",
  ];
  const packageManager =
    lockfiles.find((name) => fs.existsSync(path.join(workspace, name))) || null;
  const instructions = instructionNames
    .map((name) => {
      const file = path.join(workspace, name);
      if (!fs.existsSync(file)) return null;
      return { name, content: fs.readFileSync(file, "utf8").slice(0, 12000) };
    })
    .filter(Boolean);
  const scripts = Object.entries(packageJson.scripts || {}).map(
    ([name, command]) => ({ name, command }),
  );
  const environment = environmentFor(workspace, packageManager, scripts);
  const resources = [
    ...instructions.map((file) => ({ type: "instruction", path: file.name })),
    ...[".agents/skills", ".claude/skills", ".github/skills"].flatMap(
      (directory) => filesIn(workspace, directory, "skill"),
    ),
    ...[".mcp.json", ".vscode/mcp.json", ".claude/mcp.json"]
      .filter((name) => existing(workspace, name))
      .map((path) => ({ type: "mcp_configuration", path })),
    ...[".husky", ".github/hooks"]
      .filter((path) => existing(workspace, path))
      .map((path) => ({ type: "hook_directory", path })),
  ].slice(0, 100);
  return {
    name: packageJson.name || path.basename(workspace),
    packageManager,
    scripts,
    instructions,
    suggestions: scripts
      .filter((script) => /^(test|build|lint|check)/i.test(script.name))
      .map(
        (script) =>
          `${packageManager?.startsWith("pnpm") ? "pnpm" : "npm run"} ${script.name}`,
      ),
    environment,
    resources,
  };
}

export function projectEnvironment(store, workspace) {
  return store.one("SELECT * FROM project_environments WHERE workspace=?", [
    workspace,
  ]);
}

export function environmentValue(environment) {
  if (!environment) return null;
  const parse = (value, fallback) => {
    try {
      return JSON.parse(value || JSON.stringify(fallback));
    } catch {
      return fallback;
    }
  };
  return {
    setup: parse(environment.setup_json, []),
    filesToCopy: parse(environment.files_to_copy_json, []),
    devCommand: environment.dev_command,
    testCommand: environment.test_command,
    buildCommand: environment.build_command,
    detected: parse(environment.detected_json, {}),
    updatedAt: environment.updated_at,
  };
}

export function saveProjectEnvironment(store, workspace, environment) {
  store.run(
    "INSERT INTO project_environments(workspace,setup_json,files_to_copy_json,dev_command,test_command,build_command,detected_json,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(workspace) DO UPDATE SET setup_json=excluded.setup_json,files_to_copy_json=excluded.files_to_copy_json,dev_command=excluded.dev_command,test_command=excluded.test_command,build_command=excluded.build_command,detected_json=excluded.detected_json,updated_at=excluded.updated_at",
    [
      workspace,
      JSON.stringify(environment.setup),
      JSON.stringify(environment.filesToCopy),
      environment.devCommand,
      environment.testCommand,
      environment.buildCommand,
      JSON.stringify(environment.detected || {}),
      now(),
    ],
  );
  return environmentValue(projectEnvironment(store, workspace));
}

export function copyEnvironmentFiles(environment, source, destination) {
  const value = environmentValue(environment);
  if (!value) return [];
  const root = path.resolve(source);
  const copied = [];
  for (const relative of value.filesToCopy) {
    const from = path.resolve(root, relative);
    const target = path.resolve(destination, relative);
    const inside = (candidate, base) => {
      const relation = path.relative(base, candidate);
      return (
        relation && !relation.startsWith("..") && !path.isAbsolute(relation)
      );
    };
    if (!inside(from, root) || !inside(target, destination)) continue;
    try {
      if (!fs.statSync(from).isFile()) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(from, target);
      copied.push(relative);
    } catch {
      // Missing optional local files do not prevent isolated project work.
    }
  }
  return copied;
}

export function saveProjectProfile(store, workspace) {
  const project = inspectProject(workspace);
  const profile = {
    workspace,
    name: project.name,
    suggestions: project.suggestions.slice(0, 20),
    instructions: project.instructions.map((file) => ({
      name: file.name,
      content: file.content.slice(0, 12000),
    })),
    resources: project.resources,
  };
  store.run(
    "INSERT INTO project_profiles(id,workspace,name,suggestions_json,instructions_json,resources_json,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace) DO UPDATE SET name=excluded.name,suggestions_json=excluded.suggestions_json,instructions_json=excluded.instructions_json,resources_json=excluded.resources_json,updated_at=excluded.updated_at",
    [
      id(),
      profile.workspace,
      profile.name,
      JSON.stringify(profile.suggestions),
      JSON.stringify(profile.instructions),
      JSON.stringify(profile.resources),
      now(),
    ],
  );
  if (!projectEnvironment(store, workspace))
    saveProjectEnvironment(store, workspace, project.environment);
  return {
    ...profile,
    environment: environmentValue(projectEnvironment(store, workspace)),
  };
}

export function projectProfileMemory(profile, environment, previewPort = null) {
  const suggestions = JSON.parse(profile.suggestions_json || "[]");
  const instructions = JSON.parse(profile.instructions_json || "[]");
  const resources = JSON.parse(profile.resources_json || "[]");
  return [
    `Project profile: ${profile.name}`,
    suggestions.length ? `Suggested checks: ${suggestions.join(", ")}` : "",
    instructions.length
      ? `Project instructions:\n${instructions.map((file) => `# ${file.name}\n${file.content}`).join("\n\n")}`
      : "",
    resources.length
      ? `Discovered project resources: ${resources.map((resource) => `${resource.type}: ${resource.path}`).join(", ")}`
      : "",
    environment
      ? `Project environment: ${JSON.stringify(environmentValue(environment))}`
      : "",
    previewPort
      ? `Task environment: set ROSTER_PORT=${previewPort} for any development server. Reserved preview URL: http://127.0.0.1:${previewPort}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 24000);
}
