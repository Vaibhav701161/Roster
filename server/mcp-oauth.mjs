import crypto from "node:crypto";
import { canonicalMcpUrl } from "./mcp.mjs";

const base64url = (value) => Buffer.from(value).toString("base64url");
const random = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
const keyFor = (connectionId, name) => `mcp:${connectionId}:oauth:${name}`;

function sameValue(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function metadataRequest(url) {
  const safe = await canonicalMcpUrl(url);
  const response = await fetch(safe, {
    headers: { Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok || response.status >= 300)
    throw new Error("The authorization server did not return usable metadata.");
  const body = await response.json();
  if (!body || typeof body !== "object")
    throw new Error("The authorization server returned invalid metadata.");
  return { url: safe, body };
}

export async function authorizationServerMetadata(issuerValue) {
  const issuer = await canonicalMcpUrl(issuerValue);
  const source = new URL(issuer);
  const path = source.pathname.replace(/\/$/, "");
  const candidates = [
    `${source.origin}${path}/.well-known/oauth-authorization-server`,
    `${source.origin}/.well-known/oauth-authorization-server${path}`,
    `${source.origin}${path}/.well-known/openid-configuration`,
  ];
  let lastError;
  for (const candidate of [...new Set(candidates)]) {
    try {
      const result = await metadataRequest(candidate);
      const metadata = result.body;
      if (
        typeof metadata.authorization_endpoint === "string" &&
        typeof metadata.token_endpoint === "string"
      ) {
        await canonicalMcpUrl(metadata.authorization_endpoint);
        await canonicalMcpUrl(metadata.token_endpoint);
        if (!metadata.code_challenge_methods_supported?.includes("S256"))
          throw new Error(
            "This authorization server does not advertise PKCE S256, which Roster requires.",
          );
        return { issuer, metadataUrl: result.url, metadata };
      }
      lastError = new Error(
        "Authorization metadata is missing required endpoints.",
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw (
    lastError || new Error("No usable authorization server metadata was found.")
  );
}

async function registerClient(metadata, redirectUri, name) {
  if (typeof metadata.registration_endpoint !== "string")
    throw new Error(
      "This authorization server requires a pre-registered client. Dynamic client registration is unavailable.",
    );
  const endpoint = await canonicalMcpUrl(metadata.registration_endpoint);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: `Roster ${name}`.slice(0, 120),
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok)
    throw new Error(
      "Dynamic client registration was rejected by the authorization server.",
    );
  const registration = await response.json();
  if (typeof registration?.client_id !== "string" || !registration.client_id)
    throw new Error("Dynamic client registration did not return a client ID.");
  return registration.client_id;
}

export async function beginMcpAuthorization({
  connection,
  vault,
  redirectUri,
}) {
  let previous = {};
  try {
    previous = JSON.parse(connection.auth_metadata_json || "{}");
  } catch {
    // Re-discovery can restore valid metadata if a previous record is malformed.
  }
  const issuers = previous.authorization_servers;
  if (!Array.isArray(issuers) || !issuers.length)
    throw new Error("Discover this MCP server again before connecting it.");
  const discovery = await authorizationServerMetadata(issuers[0]);
  const saved = previous.oauth || {};
  const clientId =
    saved.issuer === discovery.issuer && typeof saved.client_id === "string"
      ? saved.client_id
      : await registerClient(
          discovery.metadata,
          redirectUri,
          connection.server_name,
        );
  const verifier = random(48);
  const challenge = base64url(
    crypto.createHash("sha256").update(verifier).digest(),
  );
  const state = random(24);
  const expiresAt = Date.now() + 10 * 60 * 1000;
  vault.setNamed(keyFor(connection.id, "verifier"), verifier);
  const authorization = new URL(discovery.metadata.authorization_endpoint);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("client_id", clientId);
  authorization.searchParams.set("redirect_uri", redirectUri);
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("resource", connection.url);
  const scopes = Array.isArray(previous.scopes_supported)
    ? previous.scopes_supported
        .filter((scope) => typeof scope === "string")
        .join(" ")
    : "";
  if (scopes) authorization.searchParams.set("scope", scopes);
  return {
    authorizationUrl: authorization.toString(),
    authMetadata: {
      ...previous,
      oauth: {
        issuer: discovery.issuer,
        metadata_url: discovery.metadataUrl,
        client_id: clientId,
        state,
        expires_at: expiresAt,
      },
    },
  };
}

export async function completeMcpAuthorization({
  connection,
  vault,
  code,
  state,
  redirectUri,
}) {
  let record = {};
  try {
    record = JSON.parse(connection.auth_metadata_json || "{}");
  } catch {
    throw new Error(
      "Authorization state is unavailable. Start the connection again.",
    );
  }
  const oauth = record.oauth || {};
  if (
    !oauth.state ||
    !sameValue(oauth.state, state) ||
    oauth.expires_at < Date.now()
  )
    throw new Error(
      "Authorization state expired or did not match. Start the connection again.",
    );
  const verifier = vault.getNamed(keyFor(connection.id, "verifier"));
  if (!verifier)
    throw new Error(
      "Authorization verifier expired. Start the connection again.",
    );
  const discovery = await authorizationServerMetadata(oauth.issuer);
  if (!sameValue(oauth.issuer, discovery.issuer))
    throw new Error(
      "The authorization server changed. Start the connection again.",
    );
  const response = await fetch(discovery.metadata.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: oauth.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: connection.url,
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error("The authorization server rejected the returned code.");
  const token = await response.json();
  if (typeof token?.access_token !== "string" || !token.access_token)
    throw new Error("The authorization server did not return an access token.");
  vault.setNamed(keyFor(connection.id, "access"), token.access_token);
  vault.setNamed(keyFor(connection.id, "refresh"), token.refresh_token || "");
  vault.setNamed(keyFor(connection.id, "verifier"), "");
  return {
    accessToken: token.access_token,
    authMetadata: {
      ...record,
      oauth: {
        issuer: discovery.issuer,
        metadata_url: discovery.metadataUrl,
        client_id: oauth.client_id,
        connected_at: new Date().toISOString(),
        expires_at:
          typeof token.expires_in === "number"
            ? Date.now() + token.expires_in * 1000
            : null,
      },
    },
  };
}

export const mcpAccessToken = (connection, vault) =>
  vault.getNamed(keyFor(connection.id, "access"));
