import { okAsync, ResultAsync } from "neverthrow";
import type { LobsterError } from "../types/index.js";
import { exec } from "./exec.js";

function caddyApi(
  adminApi: string,
  method: string,
  path: string,
  body?: unknown,
): ResultAsync<unknown, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      const res = await fetch(`${adminApi}${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Caddy API ${method} ${path} failed (${res.status}): ${text}`,
        );
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    })(),
    (e) => ({
      code: "CADDY_API_ERROR" as const,
      message: `Caddy API error: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    }),
  );
}

export function addRoute(
  adminApi: string,
  tenantName: string,
  domain: string,
  guestIp: string,
  guestPort: number,
): ResultAsync<void, LobsterError> {
  const host = `${tenantName}.${domain}`;
  const upstream = { dial: `${guestIp}:${guestPort}` };
  const transport = { protocol: "http", dial_timeout: "3s" };
  const loadBalancing = { try_duration: "30s", try_interval: "500ms" };

  // WebSocket route must come first — matches requests with Connection: Upgrade
  // and proxies without setting Connection: close (which would break the upgrade).
  const wsRoute = {
    "@id": `lobster-${tenantName}-ws`,
    match: [{ host: [host], header: { Connection: ["*Upgrade*"] } }],
    handle: [
      {
        handler: "reverse_proxy",
        upstreams: [upstream],
        transport,
        load_balancing: loadBalancing,
      },
    ],
  };

  // HTTP route sets Connection: close to prevent Caddy from pooling idle
  // upstream connections, which would be counted as active by the guest
  // agent and block auto-suspend.
  const httpRoute = {
    "@id": `lobster-${tenantName}`,
    match: [{ host: [host] }],
    handle: [
      {
        handler: "reverse_proxy",
        upstreams: [upstream],
        transport,
        load_balancing: loadBalancing,
        headers: {
          request: { set: { Connection: ["close"] } },
        },
      },
    ],
  };

  const routesPath = "/config/apps/http/servers/lobster/routes";
  return caddyApi(adminApi, "POST", routesPath, wsRoute)
    .andThen(() => caddyApi(adminApi, "POST", routesPath, httpRoute))
    .map(() => undefined);
}

export function removeRoute(
  adminApi: string,
  tenantName: string,
): ResultAsync<void, LobsterError> {
  const deleteOne = (id: string) =>
    caddyApi(adminApi, "DELETE", `/id/${id}`)
      .map(() => undefined)
      .orElse(() => okAsync(undefined));
  return deleteOne(`lobster-${tenantName}-ws`).andThen(() =>
    deleteOne(`lobster-${tenantName}`),
  );
}

export function listRoutes(
  adminApi: string,
): ResultAsync<unknown[], LobsterError> {
  return caddyApi(
    adminApi,
    "GET",
    "/config/apps/http/servers/lobster/routes",
  ).map((data) => (Array.isArray(data) ? data : []));
}

export function ensureCaddyRunning(): ResultAsync<void, LobsterError> {
  return exec(["systemctl", "enable", "--now", "caddy"]).map(() => undefined);
}

export function writeCaddyBaseConfig(
  adminApi: string,
  domain: string,
  tls?: import("../types/index.js").CaddyTlsConfig,
): ResultAsync<void, LobsterError> {
  const server: Record<string, unknown> = {
    listen: [":443", ":80"],
    routes: [],
  };

  const apps: Record<string, unknown> = {
    http: { servers: { lobster: server } },
  };

  if (tls) {
    server.tls_connection_policies = [{}];
    apps.tls = {
      certificates: {
        load_files: [{ certificate: tls.certPath, key: tls.keyPath }],
      },
      automation: {
        policies: [{ subjects: [`*.${domain}`, domain], issuers: [] }],
      },
    };
  } else {
    server.automatic_https = { disable_redirects: false };
  }

  return caddyApi(adminApi, "POST", "/load", { apps }).map(() => undefined);
}
