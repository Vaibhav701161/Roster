import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function providerKey(store, vault) {
  const endpoint = store.setting("compatible")?.endpoint;
  if (!endpoint) return "";
  const savedOrigin = store.setting("keyOrigin");
  const origin = new URL(endpoint).origin;
  if (savedOrigin === origin && vault?.get()) return vault.get();
  return origin === "https://api.openai.com"
    ? process.env.OPENAI_API_KEY || ""
    : "";
}

// Windows DPAPI binds this ciphertext to the signed-in OS user. Keys never enter
// command arguments, SQLite, logs, or a GET response. Other OSes use session memory.
export function createVault(directory) {
  const filename = path.join(directory, "web-provider-key.enc");
  let cached = "";
  const crypt = (value, protect) => {
    const operation = protect ? "Protect" : "Unprotect";
    const script = `Add-Type -AssemblyName System.Security; $inputValue = [Console]::In.ReadToEnd(); $bytes = ${protect ? "[Text.Encoding]::UTF8.GetBytes($inputValue)" : "[Convert]::FromBase64String($inputValue)"}; $result = [Security.Cryptography.ProtectedData]::${operation}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write(${protect ? "[Convert]::ToBase64String($result)" : "[Text.Encoding]::UTF8.GetString($result)"})`;
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        input: value,
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  };
  if (process.platform === "win32" && fs.existsSync(filename)) {
    try {
      cached = crypt(fs.readFileSync(filename, "utf8"), false);
    } catch {
      /* The user can reconnect if OS credentials changed. */
    }
  }
  return {
    mode: process.platform === "win32" ? "encrypted" : "session",
    get: () => cached,
    set(value) {
      if (process.platform === "win32") {
        if (value) {
          fs.mkdirSync(directory, { recursive: true });
          fs.writeFileSync(filename, crypt(value, true), { mode: 0o600 });
        } else if (fs.existsSync(filename)) fs.unlinkSync(filename);
      }
      cached = value;
    },
  };
}
