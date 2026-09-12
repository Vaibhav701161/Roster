import fs from "node:fs";
import path from "node:path";

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
