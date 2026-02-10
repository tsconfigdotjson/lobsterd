import { ResultAsync, ok } from 'neverthrow';
import type { Tenant, HealthCheckResult, LobsterError } from '../types/index.js';
import * as user from '../system/user.js';
import * as systemd from '../system/systemd.js';

export function checkLinger(tenant: Tenant): ResultAsync<HealthCheckResult, LobsterError> {
  return user.isLingerEnabled(tenant.name).map((enabled) => ({
    check: 'systemd.linger',
    status: enabled ? 'ok' : 'failed',
    message: enabled ? 'Linger enabled' : 'Linger is not enabled — user services will not persist',
  } as HealthCheckResult));
}

export function checkDockerService(tenant: Tenant): ResultAsync<HealthCheckResult, LobsterError> {
  return systemd.isActive('docker', tenant.name, tenant.uid)
    .map((active) => ({
      check: 'systemd.docker',
      status: active ? 'ok' : 'failed',
      message: active ? 'Docker service active' : 'Docker user service is not running',
    } as HealthCheckResult))
    .orElse(() => ok({
      check: 'systemd.docker',
      status: 'failed' as const,
      message: 'Could not check Docker service status',
    }));
}

export function checkGatewayService(tenant: Tenant): ResultAsync<HealthCheckResult, LobsterError> {
  return systemd.isActive('openclaw-gateway', tenant.name, tenant.uid)
    .map((active) => ({
      check: 'systemd.gateway',
      status: active ? 'ok' : 'failed',
      message: active ? 'Gateway service active' : 'OpenClaw gateway service is not running',
    } as HealthCheckResult))
    .orElse(() => ok({
      check: 'systemd.gateway',
      status: 'failed' as const,
      message: 'Could not check gateway service status',
    }));
}

export function runSystemdChecks(tenant: Tenant): ResultAsync<HealthCheckResult[], LobsterError> {
  return ResultAsync.combine([
    checkLinger(tenant),
    checkDockerService(tenant),
    checkGatewayService(tenant),
  ]);
}
