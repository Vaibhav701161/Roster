import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

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
  const filenameFor = (key) =>
    path.join(
      directory,
      `${createHash("sha256").update(String(key)).digest("hex")}.enc`,
    );
  const legacyFilename = path.join(directory, "web-provider-key.enc");
  const cache = new Map();
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
  const getNamed = (key) => {
    if (cache.has(key)) return cache.get(key);
    const filename = filenameFor(key);
    let value = "";
    if (process.platform === "win32" && fs.existsSync(filename)) {
      try {
        value = crypt(fs.readFileSync(filename, "utf8"), false);
      } catch {
        /* The user can reconnect if OS credentials changed. */
      }
    }
    cache.set(key, value);
    return value;
  };
  const setNamed = (key, value) => {
    const filename = filenameFor(key);
    if (process.platform === "win32") {
      if (value) {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(filename, crypt(value, true), { mode: 0o600 });
      } else if (fs.existsSync(filename)) fs.unlinkSync(filename);
    }
    cache.set(key, value);
  };
  const defaultKey = "compatible-provider";
  if (process.platform === "win32" && fs.existsSync(legacyFilename)) {
    try {
      cache.set(
        defaultKey,
        crypt(fs.readFileSync(legacyFilename, "utf8"), false),
      );
      fs.renameSync(legacyFilename, filenameFor(defaultKey));
    } catch {
      /* Preserve the legacy file if it cannot be unlocked or migrated. */
    }
  }
  return {
    mode: process.platform === "win32" ? "encrypted" : "session",
    get: () => getNamed(defaultKey),
    set: (value) => setNamed(defaultKey, value),
    getNamed,
    setNamed,
  };
}
