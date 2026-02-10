import { ResultAsync, ok } from 'neverthrow';
import type { Tenant, RepairResult, LobsterError } from '../types/index.js';
import * as user from '../system/user.js';
import * as systemd from '../system/systemd.js';

export function repairLinger(tenant: Tenant): ResultAsync<RepairResult, LobsterError> {
  const actions: string[] = [];
  return user.enableLinger(tenant.name)
    .map(() => { actions.push('Enabled loginctl linger'); })
    .orElse(() => ok(undefined))
    .map(() => ({
      repair: 'systemd.linger',
      fixed: true,
      actions,
    }));
}

export function repairDockerService(tenant: Tenant): ResultAsync<RepairResult, LobsterError> {
  const actions: string[] = [];
  return systemd.resetFailed('docker', tenant.name, tenant.uid)
    .map(() => { actions.push('Reset failed state for docker service'); })
    .orElse(() => ok(undefined))
    .andThen(() => systemd.restartService('docker', tenant.name, tenant.uid))
    .map(() => { actions.push('Restarted docker service'); })
    .orElse(() => ok(undefined))
    .map(() => ({
      repair: 'systemd.docker',
      fixed: actions.length > 0,
      actions,
    }));
}

export function repairGatewayService(tenant: Tenant): ResultAsync<RepairResult, LobsterError> {
  const actions: string[] = [];
  return systemd.resetFailed('openclaw-gateway', tenant.name, tenant.uid)
    .map(() => { actions.push('Reset failed state for gateway service'); })
    .orElse(() => ok(undefined))
    .andThen(() => systemd.restartService('openclaw-gateway', tenant.name, tenant.uid))
    .map(() => { actions.push('Restarted gateway service'); })
    .orElse(() => ok(undefined))
    .map(() => ({
      repair: 'systemd.gateway',
      fixed: actions.length > 0,
      actions,
    }));
}
