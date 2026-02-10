import { ResultAsync } from 'neverthrow';
import type { Tenant, HealthCheckResult, LobsterError } from '../types/index.js';
import { runSystemdChecks } from './systemd.js';
import { runDockerChecks } from './docker.js';
import { runZfsChecks } from './zfs.js';
import { runFilesystemChecks } from './filesystem.js';
import { runGatewayChecks } from './gateway.js';

export function runAllChecks(tenant: Tenant): ResultAsync<HealthCheckResult[], LobsterError> {
  return ResultAsync.combine([
    runSystemdChecks(tenant),
    runDockerChecks(tenant),
    runZfsChecks(tenant),
    runFilesystemChecks(tenant),
    runGatewayChecks(tenant),
  ]).map((groups) => groups.flat());
}

/** Quick checks: only systemd + docker, skip slow checks */
export function runQuickChecks(tenant: Tenant): ResultAsync<HealthCheckResult[], LobsterError> {
  return ResultAsync.combine([
    runSystemdChecks(tenant),
    runDockerChecks(tenant),
  ]).map((groups) => groups.flat());
}
