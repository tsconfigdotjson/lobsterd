import { okAsync, ResultAsync } from "neverthrow";
import * as caddy from "../system/caddy.js";
import { execUnchecked } from "../system/exec.js";
import * as vsock from "../system/vsock.js";
import type {
  HealthCheckResult,
  LobsterdConfig,
  LobsterError,
  Tenant,
} from "../types/index.js";

export function checkTapDevice(
  tenant: Tenant,
): ResultAsync<HealthCheckResult, LobsterError> {
  return execUnchecked(["ip", "link", "show", tenant.tapDev])
    .map(
      (r): HealthCheckResult =>
        r.exitCode === 0
          ? {
              check: "net.tap",
              status: "ok",
              message: `TAP device ${tenant.tapDev} exists`,
            }
          : {
              check: "net.tap",
              status: "failed",
              message: `TAP device ${tenant.tapDev} not found`,
            },
    )
    .orElse(() =>
      okAsync<HealthCheckResult, LobsterError>({
        check: "net.tap",
        status: "failed",
        message: `Failed to check TAP device ${tenant.tapDev}`,
      }),
    );
}

export function checkGatewayPort(
  tenant: Tenant,
  config: LobsterdConfig,
): ResultAsync<HealthCheckResult, LobsterError> {
  if (tenant.status === "suspended") {
    return okAsync({
      check: "net.gateway",
      status: "ok",
      message: "Skipped — tenant is suspended",
    } as HealthCheckResult);
  }
  // Check via the agent's get-stats (which reports gatewayPid) instead of
  // opening a TCP connection to port 9000 from the host — that connection
  // gets counted as an active client by the idle-detection poller.
  return vsock
    .getStats(tenant.ipAddress, config.vsock.agentPort, tenant.agentToken)
    .map(
      (stats): HealthCheckResult =>
        stats.gatewayPid
          ? {
              check: "net.gateway",
              status: "ok",
              message: `Gateway running (PID ${stats.gatewayPid})`,
            }
          : {
              check: "net.gateway",
              status: "failed",
              message: "Gateway process is not running",
            },
    )
    .orElse(() =>
      okAsync<HealthCheckResult, LobsterError>({
        check: "net.gateway",
        status: "failed",
        message: "Failed to query agent for gateway status",
      }),
    );
}

export function checkCaddyRoute(
  tenant: Tenant,
  adminApi: string,
): ResultAsync<HealthCheckResult, LobsterError> {
  return caddy
    .listRoutes(adminApi)
    .map((routes): HealthCheckResult => {
      const id = (r: unknown) =>
        (r as Record<string, unknown>)?.["@id"] as string | undefined;
      const found =
        routes.some((r) => id(r) === `lobster-${tenant.name}`) &&
        routes.some((r) => id(r) === `lobster-${tenant.name}-ws`);
      return found
        ? {
            check: "net.caddy-route",
            status: "ok",
            message: `Caddy route lobster-${tenant.name} exists`,
          }
        : {
            check: "net.caddy-route",
            status: "failed",
            message: `Caddy route lobster-${tenant.name} not found`,
          };
    })
    .orElse(() =>
      okAsync<HealthCheckResult, LobsterError>({
        check: "net.caddy-route",
        status: "failed",
        message: "Failed to query Caddy routes",
      }),
    );
}

export function runNetworkChecks(
  tenant: Tenant,
  adminApi: string,
  config: LobsterdConfig,
): ResultAsync<HealthCheckResult[], LobsterError> {
  return ResultAsync.combine([
    checkTapDevice(tenant),
    checkGatewayPort(tenant, config),
    checkCaddyRoute(tenant, adminApi),
  ]);
}
