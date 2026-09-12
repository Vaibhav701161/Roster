import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "../server/index.mjs";
const require = createRequire(import.meta.url);
if (process.loadEnvFile) {
  try {
    process.loadEnvFile(".env");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const web = process.argv.includes("--web");
let service,
  desktop,
  closing = false;
if (web) service = await createServer({ port: 4318 });
const vite = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "--host",
    "127.0.0.1",
    "--port",
    "5173",
    "--strictPort",
  ],
  { windowsHide: true, stdio: "inherit" },
);
async function close(code = 0) {
  if (closing) return;
  closing = true;
  vite.kill();
  desktop?.kill();
  if (service) await service.close();
  process.exit(code);
}
vite.on("error", (error) => {
  console.error(error.message);
  close(1);
});
vite.on("exit", (code) => {
  if (!closing) close(code || 0);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => close());
if (web) console.log(`Roster service: ${service.url}`);
else {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch("http://127.0.0.1:5173");
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) {
    console.error("The frontend could not start on port 5173.");
    await close(1);
  }
  const env = { ...process.env, ROSTER_DEV_URL: "http://127.0.0.1:5173" };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = spawn(require("electron"), ["."], {
    windowsHide: true,
    stdio: "inherit",
    env,
  });
  desktop.on("exit", () => close());
  desktop.on("error", (error) => {
    console.error(error.message);
    close(1);
  });
}
