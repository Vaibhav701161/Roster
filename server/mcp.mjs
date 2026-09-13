import dns from "node:dns/promises";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import readline from "node:readline";

const protocolVersion = "2025-11-25";
const privateV4 =
  /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.|192\.168\.)/;

function isLoopback(hostname) {
  return (
    hostname === "localhost" || hostname === "::1" || hostname === "127.0.0.1"
  );
}

function unsafeAddress(address) {
  return (
    address === "::1" ||
    address.startsWith("fe80:") ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    privateV4.test(address)
  );
}

export async function canonicalMcpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a complete MCP server URL.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      "MCP servers must use an HTTP or HTTPS URL without credentials.",
    );
  if (url.hash) throw new Error("MCP server URLs cannot include a fragment.");
  if (url.protocol === "http:" && !isLoopback(url.hostname))
    throw new Error("Use HTTPS for remote MCP servers.");
  if (!isLoopback(url.hostname)) {
    const addresses = await dns.lookup(url.hostname, { all: true });
    if (
      !addresses.length ||
      addresses.some((entry) => unsafeAddress(entry.address))
    )
      throw new Error("MCP server address is not publicly reachable.");
  }
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function mcpRequest() {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: "roster-discovery",
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "Roster", version: "0.1.0" },
    },
  });
}

function rpc(method, params, id) {
  return JSON.stringify({
    jsonrpc: "2.0",
    ...(id ? { id } : {}),
    method,
    ...(params === undefined ? {} : { params }),
  });
}

function initialization() {
  return {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "Roster", version: "0.1.0" },
  };
}

function mcpHeaders(accessToken = "") {
  return {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": protocolVersion,
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

function sessionHeaders(sessionId = "", accessToken = "") {
  return {
    ...mcpHeaders(accessToken),
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
  };
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(7000),
    ...options,
  });
  if (response.status >= 300 && response.status < 400)
    throw new Error("MCP discovery does not follow redirects.");
  return response;
}

async function json(response) {
  const text = await response.text();
  if (!text) return {};
  const event = text.match(/^data:\s*(.+)$/m)?.[1];
  try {
    return JSON.parse(event || text);
  } catch {
    throw new Error("MCP server returned an invalid discovery response.");
  }
}

function challengeMetadata(header) {
  return header?.match(/resource_metadata\s*=\s*"([^"]+)"/i)?.[1] || "";
}

function metadataCandidates(endpoint, challenge) {
  if (challenge) return [challenge];
  const url = new URL(endpoint);
  const path = url.pathname === "/" ? "" : url.pathname;
  return [
    `${url.origin}/.well-known/oauth-protected-resource${path}`,
    `${url.origin}/.well-known/oauth-protected-resource`,
  ];
}

async function protectedMetadata(endpoint, challenge) {
  for (const candidate of metadataCandidates(endpoint, challenge)) {
    try {
      const safe = await canonicalMcpUrl(candidate);
      const response = await request(safe, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) continue;
      const metadata = await json(response);
      if (Array.isArray(metadata.authorization_servers))
        return { url: safe, metadata };
    } catch {
      // Try the next standards-defined metadata location.
    }
  }
  return null;
}

async function initialize(url, accessToken = "") {
  const response = await request(url, {
    method: "POST",
    headers: mcpHeaders(accessToken),
    body: mcpRequest(),
  });
  if (!response.ok)
    throw new Error(
      `MCP server returned ${response.status} during initialization.`,
    );
  const body = await json(response);
  if (body.error)
    throw new Error(
      body.error.message || "MCP server rejected initialization.",
    );
  return {
    result: body.result || {},
    sessionId: response.headers.get("mcp-session-id") || "",
  };
}

async function discoverTools(url, sessionId = "", accessToken = "") {
  await request(url, {
    method: "POST",
    headers: sessionHeaders(sessionId, accessToken),
    body: rpc("notifications/initialized"),
  });
  const response = await request(url, {
    method: "POST",
    headers: sessionHeaders(sessionId, accessToken),
    body: rpc("tools/list", {}, "roster-tools"),
  });
  if (!response.ok) return [];
  const payload = await json(response);
  return Array.isArray(payload.result?.tools)
    ? payload.result.tools.slice(0, 100).map((tool) => ({
        name: String(tool.name || "Unnamed tool").slice(0, 200),
        description: String(tool.description || "").slice(0, 2000),
        inputSchema: tool.inputSchema || {},
      }))
    : [];
}

export async function callMcpTool(urlValue, name, args = {}, accessToken = "") {
  const url = await canonicalMcpUrl(urlValue);
  const initialized = await initialize(url, accessToken);
  if (!initialized.result.capabilities?.tools)
    throw new Error("This MCP server does not advertise tool support.");
  await request(url, {
    method: "POST",
    headers: sessionHeaders(initialized.sessionId, accessToken),
    body: rpc("notifications/initialized"),
  });
  const response = await request(url, {
    method: "POST",
    headers: sessionHeaders(initialized.sessionId, accessToken),
    body: rpc("tools/call", { name, arguments: args }, "roster-tool-call"),
  });
  if (!response.ok)
    throw new Error(
      `MCP server returned ${response.status} while calling ${name}.`,
    );
  const body = await json(response);
  if (body.error)
    throw new Error(
      body.error.message || `MCP tool ${name} returned an error.`,
    );
  const result = body.result || {};
  const serialized = JSON.stringify(result);
  if (serialized.length > 200000)
    throw new Error("MCP tool response exceeded Roster's 200 KB safety limit.");
  return result;
}

function validStdioConfig(config) {
  if (
    !config ||
    typeof config.command !== "string" ||
    !config.command.trim() ||
    config.command.length > 1000 ||
    config.command.includes("\0") ||
    !Array.isArray(config.args) ||
    config.args.length > 50 ||
    config.args.some(
      (arg) =>
        typeof arg !== "string" || arg.length > 2000 || arg.includes("\0"),
    )
  )
    throw new Error("Enter a local MCP command and up to 50 safe arguments.");
  return { command: config.command.trim(), args: config.args };
}

async function withStdioSession(config, work) {
  const safe = validStdioConfig(config);
  const child = spawn(safe.command, safe.args, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  });
  const pending = new Map();
  let stderr = "",
    terminalError = null;
  const fail = (error) => {
    if (terminalError) return;
    terminalError = error;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };
  child.once("error", (error) => fail(error));
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4000);
  });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line.length > 1024 * 1024)
      return fail(new Error("Local MCP server sent an oversized response."));
    try {
      const payload = JSON.parse(line);
      const key = String(payload.id || "");
      const waiting = pending.get(key);
      if (!waiting) return;
      pending.delete(key);
      clearTimeout(waiting.timer);
      if (payload.error)
        waiting.reject(
          new Error(payload.error.message || "Local MCP returned an error."),
        );
      else waiting.resolve(payload.result || {});
    } catch {
      fail(new Error("Local MCP server returned invalid JSON-RPC output."));
    }
  });
  child.once("exit", (code) => {
    if (!terminalError && pending.size)
      fail(
        new Error(
          `Local MCP server exited${code === null ? "" : ` with code ${code}`}${stderr ? `: ${stderr}` : ""}`,
        ),
      );
  });
  const send = (method, params, requestId) => {
    if (terminalError) return Promise.reject(terminalError);
    const payload = rpc(method, params, requestId);
    if (!requestId) {
      child.stdin.write(payload + "\n");
      return Promise.resolve({});
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Local MCP timed out while calling ${method}.`));
      }, 7000);
      pending.set(requestId, { resolve, reject, timer });
      child.stdin.write(payload + "\n");
    });
  };
  try {
    const initialized = await send(
      "initialize",
      initialization(),
      "roster-discovery",
    );
    await send("notifications/initialized");
    return await work({ result: initialized, send });
  } finally {
    lines.close();
    fail(new Error("Local MCP session closed."));
    child.kill();
  }
}

export async function discoverLocalMcp(config) {
  const safe = validStdioConfig(config);
  const connectionId = crypto
    .createHash("sha256")
    .update(JSON.stringify(safe))
    .digest("hex")
    .slice(0, 24);
  const { result, tools } = await withStdioSession(safe, async (session) => {
    const tools = session.result.capabilities?.tools
      ? await session.send("tools/list", {}, "roster-tools")
      : {};
    return {
      result: session.result,
      tools: Array.isArray(tools.tools)
        ? tools.tools.slice(0, 100).map((tool) => ({
            name: String(tool.name || "Unnamed tool").slice(0, 200),
            description: String(tool.description || "").slice(0, 2000),
            inputSchema: tool.inputSchema || {},
          }))
        : [],
    };
  });
  return {
    id: connectionId,
    url: `stdio://${connectionId}`,
    transport: "stdio",
    stdio: safe,
    status: "available",
    detail: `Local MCP server initialized.${tools.length ? ` ${tools.length} tool${tools.length === 1 ? "" : "s"} discovered.` : ""}`,
    serverName: result.serverInfo?.name || safe.command,
    protocolVersion: result.protocolVersion || protocolVersion,
    capabilities: Object.keys(result.capabilities || {}),
    tools,
    authMetadata: {},
  };
}

export async function callLocalMcpTool(config, name, args = {}) {
  const result = await withStdioSession(config, (session) => {
    if (!session.result.capabilities?.tools)
      throw new Error("This local MCP server does not advertise tool support.");
    return session.send(
      "tools/call",
      { name, arguments: args },
      "roster-tool-call",
    );
  });
  const serialized = JSON.stringify(result);
  if (serialized.length > 200000)
    throw new Error(
      "Local MCP tool response exceeded Roster's 200 KB safety limit.",
    );
  return result;
}

export async function discoverMcp(value, accessToken = "") {
  const url = await canonicalMcpUrl(value);
  const response = await request(url, {
    method: "POST",
    headers: mcpHeaders(accessToken),
    body: mcpRequest(),
  });
  const connectionId = crypto
    .createHash("sha256")
    .update(url)
    .digest("hex")
    .slice(0, 24);
  if (response.status === 401) {
    const protectedResource = await protectedMetadata(
      url,
      challengeMetadata(response.headers.get("www-authenticate")),
    );
    const metadata = protectedResource?.metadata || {};
    return {
      id: connectionId,
      url,
      status: "authentication_required",
      detail: protectedResource
        ? "Authentication is required. Authorization metadata was discovered."
        : "Authentication is required, but the server did not expose usable authorization metadata.",
      serverName: new URL(url).hostname,
      protocolVersion,
      capabilities: [],
      authMetadata: {
        protected_resource_metadata: protectedResource?.url || "",
        authorization_servers: metadata.authorization_servers || [],
        scopes_supported: metadata.scopes_supported || [],
      },
      transport: "remote",
      stdio: {},
    };
  }
  const body = await json(response);
  if (body.error)
    throw new Error(
      body.error.message || "MCP server rejected initialization.",
    );
  const result = body.result || {};
  const sessionId = response.headers.get("mcp-session-id") || "";
  let tools = [];
  let toolDetail = "";
  if (result.capabilities?.tools) {
    try {
      tools = await discoverTools(url, sessionId, accessToken);
    } catch {
      toolDetail =
        " The server accepted initialization, but its tool registry was unavailable.";
    }
  }
  return {
    id: connectionId,
    url,
    status: "available",
    detail: `The server accepted an unauthenticated initialization request.${tools.length ? ` ${tools.length} tool${tools.length === 1 ? "" : "s"} discovered.` : toolDetail}`,
    serverName: result.serverInfo?.name || new URL(url).hostname,
    protocolVersion: result.protocolVersion || protocolVersion,
    capabilities: Object.keys(result.capabilities || {}),
    tools,
    authMetadata: {},
    transport: "remote",
    stdio: {},
  };
}
