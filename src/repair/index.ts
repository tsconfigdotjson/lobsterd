import { ResultAsync, ok } from 'neverthrow';
import type { Tenant, HealthCheckResult, RepairResult, LobsterError } from '../types/index.js';
import { repairLinger, repairDockerService, repairGatewayService } from './systemd.js';
import { repairDocker } from './docker.js';
import { repairZfs } from './zfs.js';
import { repairFilesystem } from './filesystem.js';
import { repairGateway } from './gateway.js';

/** Map check names to repair functions */
const REPAIR_MAP: Record<string, ((tenant: Tenant) => ResultAsync<RepairResult, LobsterError>)[]> = {
  'systemd.linger': [repairLinger],
  'systemd.docker': [repairDockerService],
  'systemd.gateway': [repairGatewayService],
  'docker.socket': [repairDocker],
  'docker.responsive': [repairDocker],
  'zfs.mounted': [repairZfs],
  'zfs.quota': [repairZfs],
  'fs.home': [repairFilesystem],
  'fs.home-perms': [repairFilesystem],
  'fs.openclaw': [repairFilesystem],
  'fs.xdg': [repairFilesystem],
  'gateway.port': [repairGateway],
};

export function runRepairs(
  tenant: Tenant,
  failedChecks: HealthCheckResult[],
): ResultAsync<RepairResult[], LobsterError> {
  // Collect unique repair functions for all failed checks
  const seen = new Set<Function>();
  const repairFns: ((tenant: Tenant) => ResultAsync<RepairResult, LobsterError>)[] = [];

  for (const check of failedChecks) {
    const repairs = REPAIR_MAP[check.check] ?? [];
    for (const fn of repairs) {
      if (!seen.has(fn)) {
        seen.add(fn);
        repairFns.push(fn);
      }
    }
  }

  if (repairFns.length === 0) {
    return ResultAsync.fromSafePromise(Promise.resolve([]));
  }

  // Run repairs sequentially (order matters: filesystem before docker before gateway)
  return repairFns.reduce<ResultAsync<RepairResult[], LobsterError>>(
    (acc, fn) =>
      acc.andThen((results) =>
        fn(tenant)
          .map((result) => [...results, result])
          .orElse(() => ok([...results, { repair: 'unknown', fixed: false, actions: ['Repair threw an error'] }])),
      ),
    ResultAsync.fromSafePromise(Promise.resolve([])),
  );
}
