import { ResultAsync, ok } from 'neverthrow';
import type { Tenant, RepairResult, LobsterError } from '../types/index.js';
import * as systemd from '../system/systemd.js';

export function repairGateway(tenant: Tenant): ResultAsync<RepairResult, LobsterError> {
  const actions: string[] = [];

  return systemd.resetFailed('openclaw-gateway', tenant.name, tenant.uid)
    .map(() => { actions.push('Reset failed state'); })
    .orElse(() => ok(undefined))
    .andThen(() => systemd.restartService('openclaw-gateway', tenant.name, tenant.uid))
    .map(() => { actions.push('Restarted OpenClaw gateway'); })
    .orElse(() => ok(undefined))
    .map(() => ({
      repair: 'gateway',
      fixed: actions.length > 0,
      actions,
    }));
}
