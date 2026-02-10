import { ok, errAsync, okAsync, ResultAsync } from 'neverthrow';
import type { LobsterError } from '../types/index.js';
import { loadConfig, loadRegistry } from '../config/loader.js';
import * as zfs from '../system/zfs.js';

function formatSnapName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

export function runSnap(
  name: string,
  opts: { prune?: boolean } = {},
): ResultAsync<string, LobsterError> {
  let dataset: string;
  let retention: number;

  return loadConfig()
    .andThen((config) => {
      retention = config.zfs.snapshotRetention;
      return loadRegistry();
    })
    .andThen((registry): ResultAsync<string, LobsterError> => {
      const tenant = registry.tenants.find((t) => t.name === name);
      if (!tenant) {
        return errAsync({ code: 'TENANT_NOT_FOUND', message: `Tenant "${name}" not found` });
      }
      dataset = tenant.zfsDataset;
      const snapName = formatSnapName();
      return zfs.snapshot(dataset, snapName).map(() => snapName);
    })
    .andThen((snapName): ResultAsync<string, LobsterError> => {
      if (!opts.prune) return okAsync(snapName);

      return zfs.listSnapshots(dataset).andThen((snaps) => {
        if (snaps.length <= retention) return okAsync(snapName);
        const toRemove = snaps.slice(0, snaps.length - retention);
        return ResultAsync.combine(
          toRemove.map((s) => zfs.destroySnapshot(s)),
        ).map(() => snapName);
      });
    });
}
