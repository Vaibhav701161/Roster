import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function command(commandName, args, options = {}) {
  const { stdout } = await exec(commandName, args, {
    windowsHide: true,
    timeout: options.timeout || 15000,
    maxBuffer: 200000,
  });
  return String(stdout).trim();
}

function hostname(status) {
  const value = String(status?.Self?.DNSName || "")
    .trim()
    .replace(/\.$/, "");
  if (!/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(value)) return "";
  return value;
}

export async function remoteStatus(commandFn = command) {
  try {
    const output = await commandFn("tailscale", ["status", "--json"]);
    const status = JSON.parse(output);
    const dnsName = hostname(status);
    return {
      available: true,
      connected: Boolean(dnsName && status?.BackendState === "Running"),
      dnsName,
      url: dnsName ? `https://${dnsName}` : "",
    };
  } catch {
    return {
      available: false,
      connected: false,
      dnsName: "",
      url: "",
    };
  }
}

export async function enableRemoteAccess(port, commandFn = command) {
  const status = await remoteStatus(commandFn);
  if (!status.available)
    throw new Error(
      "Install Tailscale and sign this desktop into your private tailnet before enabling remote companion access.",
    );
  if (!status.connected)
    throw new Error(
      "Connect Tailscale on this desktop before enabling remote companion access.",
    );
  await commandFn("tailscale", [
    "serve",
    "--https=443",
    "--set-path=/",
    "--bg",
    `http://127.0.0.1:${port}`,
  ]);
  return status;
}

export async function disableRemoteAccess(commandFn = command) {
  try {
    await commandFn("tailscale", [
      "serve",
      "--https=443",
      "--set-path=/",
      "off",
    ]);
  } catch {
    // Remote access remains disabled in Roster even if Tailscale has stopped.
  }
}
