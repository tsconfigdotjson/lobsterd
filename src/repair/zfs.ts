import { ResultAsync, ok } from 'neverthrow';
import type { Tenant, RepairResult, LobsterError } from '../types/index.js';
import * as zfs from '../system/zfs.js';
import { loadConfig } from '../config/loader.js';

export function repairZfs(tenant: Tenant): ResultAsync<RepairResult, LobsterError> {
  const actions: string[] = [];

  return zfs.isMounted(tenant.zfsDataset)
    .andThen((mounted) => {
      if (!mounted) {
        return zfs.mount(tenant.zfsDataset).map(() => {
          actions.push(`Remounted dataset ${tenant.zfsDataset}`);
        });
      }
      return ok(undefined);
    })
    .orElse(() => {
      actions.push('Failed to remount dataset');
      return ok(undefined);
    })
    .andThen(() => loadConfig())
    .andThen((config) => {
      // Prune old snapshots if near quota
      return zfs.listSnapshots(tenant.zfsDataset).andThen((snaps) => {
        if (snaps.length > config.zfs.snapshotRetention) {
          const toRemove = snaps.slice(0, snaps.length - config.zfs.snapshotRetention);
          actions.push(`Pruning ${toRemove.length} old snapshot(s)`);
          return ResultAsync.combine(
            toRemove.map((s) => zfs.destroySnapshot(s).orElse(() => ok(undefined))),
          ).map(() => undefined);
        }
        return ok(undefined);
      });
    })
    .orElse(() => ok(undefined))
    .map(() => ({
      repair: 'zfs',
      fixed: actions.length > 0,
      actions,
    }));
}
