import { ResultAsync, ok } from 'neverthrow';
import type { Tenant, RepairResult, LobsterError } from '../types/index.js';
import { exec } from '../system/exec.js';

export function repairFilesystem(tenant: Tenant): ResultAsync<RepairResult, LobsterError> {
  const actions: string[] = [];
  const dirs = [
    tenant.homePath,
    `${tenant.homePath}/.config`,
    `${tenant.homePath}/.config/systemd/user`,
    `${tenant.homePath}/.local/share`,
    `${tenant.homePath}/.openclaw`,
  ];

  // Create missing dirs
  return exec(['mkdir', '-p', ...dirs])
    .map(() => { actions.push('Ensured all directories exist'); })
    .orElse(() => ok(undefined))
    .andThen(() =>
      // Fix ownership
      exec(['chown', '-R', `${tenant.uid}:${tenant.gid}`, tenant.homePath])
        .map(() => { actions.push(`Fixed ownership to ${tenant.uid}:${tenant.gid}`); })
        .orElse(() => ok(undefined)),
    )
    .andThen(() =>
      // Fix home dir permissions to 0700
      exec(['chmod', '0700', tenant.homePath])
        .map(() => { actions.push(`Set home directory permissions to 0700`); })
        .orElse(() => ok(undefined)),
    )
    .map(() => ({
      repair: 'filesystem',
      fixed: actions.length > 0,
      actions,
    }));
}
