import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const browserScript = /(?:playwright|e2e|end[-_ ]?to[-_ ]?end|browser|ui)/i;
const safeScriptName = /^[a-z0-9:_-]+$/i;

export function detectedBrowserScripts(workspace) {
  if (!workspace) return [];
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(workspace, "package.json"), "utf8"),
    );
    return Object.entries(manifest.scripts || {})
      .filter(
        ([name, command]) =>
          safeScriptName.test(name) &&
          (browserScript.test(name) || browserScript.test(String(command))),
      )
      .slice(0, 20)
      .map(([name, command]) => ({
        name,
        command: String(command).slice(0, 500),
      }));
  } catch {
    return [];
  }
}

export async function runBrowserScript(task, script) {
  const workspace = task.worktree_path || task.workspace;
  const found = detectedBrowserScripts(workspace).find(
    (item) => item.name === script,
  );
  if (!found)
    throw new Error(
      "Choose a detected browser or end-to-end script from this task's project.",
    );
  const command = `npm run ${found.name}`;
  try {
    const executable = process.platform === "win32" ? "cmd.exe" : "npm";
    const args =
      process.platform === "win32"
        ? ["/d", "/s", "/c", command]
        : ["run", found.name];
    const { stdout = "", stderr = "" } = await exec(executable, args, {
      cwd: workspace,
      windowsHide: true,
      timeout: 5 * 60 * 1000,
      maxBuffer: 1024 * 1024,
    });
    return {
      status: "pass",
      command,
      output: `${command}\n\n${stdout}${stderr ? `\n${stderr}` : ""}`.slice(
        0,
        500000,
      ),
      summary: `${command} completed successfully.`,
    };
  } catch (error) {
    const stdout = String(error.stdout || "");
    const stderr = String(error.stderr || error.message || "");
    return {
      status: "fail",
      command,
      output: `${command}\n\n${stdout}${stderr ? `\n${stderr}` : ""}`.slice(
        0,
        500000,
      ),
      summary: `${command} failed. ${stderr}`.slice(0, 3000),
    };
  }
}
