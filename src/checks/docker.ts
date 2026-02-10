import { ResultAsync, ok } from 'neverthrow';
import type { Tenant, HealthCheckResult, LobsterError } from '../types/index.js';
import * as docker from '../system/docker.js';

export function checkDockerSocket(tenant: Tenant): ResultAsync<HealthCheckResult, LobsterError> {
  return ResultAsync.fromPromise(
    Bun.file(`/run/user/${tenant.uid}/docker.sock`).exists(),
    () => ({ code: 'EXEC_FAILED' as const, message: 'Failed to check docker socket' }),
  ).map((exists) => ({
    check: 'docker.socket',
    status: exists ? 'ok' : 'failed',
    message: exists ? 'Docker socket exists' : `Docker socket missing at /run/user/${tenant.uid}/docker.sock`,
  } as HealthCheckResult));
}

export function checkDockerResponsive(tenant: Tenant): ResultAsync<HealthCheckResult, LobsterError> {
  return docker.isResponsive(tenant.name, tenant.uid)
    .map((responsive) => ({
      check: 'docker.responsive',
      status: responsive ? 'ok' : 'failed',
      message: responsive ? 'Docker daemon responsive' : 'Docker daemon not responding to docker info',
    } as HealthCheckResult))
    .orElse(() => ok({
      check: 'docker.responsive',
      status: 'failed' as const,
      message: 'Docker daemon check failed',
    }));
}

export function runDockerChecks(tenant: Tenant): ResultAsync<HealthCheckResult[], LobsterError> {
  return ResultAsync.combine([
    checkDockerSocket(tenant),
    checkDockerResponsive(tenant),
  ]);
}
