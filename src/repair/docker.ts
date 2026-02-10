import { ResultAsync, ok } from 'neverthrow';
import type { Tenant, RepairResult, LobsterError } from '../types/index.js';
import * as docker from '../system/docker.js';
import * as systemd from '../system/systemd.js';

export function repairDocker(tenant: Tenant): ResultAsync<RepairResult, LobsterError> {
  const actions: string[] = [];

  return docker.removeStaleSocket(tenant.uid)
    .map(() => { actions.push('Removed stale Docker socket/pid files'); })
    .orElse(() => ok(undefined))
    .andThen(() => systemd.resetFailed('docker', tenant.name, tenant.uid))
    .map(() => { actions.push('Reset docker service failed state'); })
    .orElse(() => ok(undefined))
    .andThen(() => systemd.restartService('docker', tenant.name, tenant.uid))
    .map(() => { actions.push('Restarted docker service'); })
    .orElse(() => ok(undefined))
    .map(() => ({
      repair: 'docker',
      fixed: actions.length > 0,
      actions,
    }));
}
