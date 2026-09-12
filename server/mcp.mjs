import dns from "node:dns/promises";
import crypto from "node:crypto";

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

export async function discoverMcp(value) {
  const url = await canonicalMcpUrl(value);
  const response = await request(url, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": protocolVersion,
    },
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
    };
  }
  if (!response.ok)
    throw new Error(
      `MCP server returned ${response.status} during initialization.`,
    );
  const body = await json(response);
  if (body.error)
    throw new Error(
      body.error.message || "MCP server rejected initialization.",
    );
  const result = body.result || {};
  return {
    id: connectionId,
    url,
    status: "available",
    detail: "The server accepted an unauthenticated initialization request.",
    serverName: result.serverInfo?.name || new URL(url).hostname,
    protocolVersion: result.protocolVersion || protocolVersion,
    capabilities: Object.keys(result.capabilities || {}),
    authMetadata: {},
  };
}
