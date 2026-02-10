import { ResultAsync, ok } from 'neverthrow';
import type { Tenant, HealthCheckResult, LobsterError } from '../types/index.js';

export function checkGatewayPort(tenant: Tenant): ResultAsync<HealthCheckResult, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      try {
        const socket = await Bun.connect({
          hostname: '127.0.0.1',
          port: tenant.gatewayPort,
          socket: {
            data() {},
            open(socket) { socket.end(); },
            error() {},
            close() {},
          },
        });
        return true;
      } catch {
        return false;
      }
    })(),
    () => ({ code: 'EXEC_FAILED' as const, message: 'Failed to check gateway port' }),
  ).map((reachable) => ({
    check: 'gateway.port',
    status: reachable ? 'ok' : 'failed',
    message: reachable
      ? `Gateway responding on port ${tenant.gatewayPort}`
      : `Gateway not responding on port ${tenant.gatewayPort}`,
  } as HealthCheckResult));
}

export function runGatewayChecks(tenant: Tenant): ResultAsync<HealthCheckResult[], LobsterError> {
  return ResultAsync.combine([
    checkGatewayPort(tenant),
  ]);
}
