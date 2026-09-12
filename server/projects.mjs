import fs from "node:fs";
import path from "node:path";
import { id, now } from "./store.mjs";

const instructionNames = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  ".github/copilot-instructions.md",
];

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
  };
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
  };
  store.run(
    "INSERT INTO project_profiles(id,workspace,name,suggestions_json,instructions_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(workspace) DO UPDATE SET name=excluded.name,suggestions_json=excluded.suggestions_json,instructions_json=excluded.instructions_json,updated_at=excluded.updated_at",
    [
      id(),
      profile.workspace,
      profile.name,
      JSON.stringify(profile.suggestions),
      JSON.stringify(profile.instructions),
      now(),
    ],
  );
  return profile;
}

export function projectProfileMemory(profile) {
  const suggestions = JSON.parse(profile.suggestions_json || "[]");
  const instructions = JSON.parse(profile.instructions_json || "[]");
  return [
    `Project profile: ${profile.name}`,
    suggestions.length ? `Suggested checks: ${suggestions.join(", ")}` : "",
    instructions.length
      ? `Project instructions:\n${instructions.map((file) => `# ${file.name}\n${file.content}`).join("\n\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 24000);
}
