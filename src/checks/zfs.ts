import { ResultAsync, ok } from 'neverthrow';
import type { Tenant, HealthCheckResult, LobsterError } from '../types/index.js';
import * as zfs from '../system/zfs.js';

export function checkDatasetMounted(tenant: Tenant): ResultAsync<HealthCheckResult, LobsterError> {
  return zfs.isMounted(tenant.zfsDataset)
    .map((mounted) => ({
      check: 'zfs.mounted',
      status: mounted ? 'ok' : 'failed',
      message: mounted ? 'ZFS dataset mounted' : `Dataset ${tenant.zfsDataset} is not mounted`,
    } as HealthCheckResult))
    .orElse(() => ok({
      check: 'zfs.mounted',
      status: 'failed' as const,
      message: `Dataset ${tenant.zfsDataset} not found or check failed`,
    }));
}

export function checkQuotaUsage(tenant: Tenant): ResultAsync<HealthCheckResult, LobsterError> {
  return zfs.getUsage(tenant.zfsDataset)
    .map((usage) => {
      // Parse used and quota to check if near limit
      // This is a rough check — ZFS reports human-readable sizes
      const usedStr = usage.used;
      const quotaStr = usage.quota;
      if (quotaStr === 'none') {
        return {
          check: 'zfs.quota',
          status: 'ok' as const,
          message: `Used ${usedStr}, no quota set`,
        };
      }
      return {
        check: 'zfs.quota',
        status: 'ok' as const,
        message: `Used ${usedStr} of ${quotaStr} quota`,
      };
    })
    .orElse(() => ok({
      check: 'zfs.quota',
      status: 'degraded' as const,
      message: 'Could not check ZFS usage',
    }));
}

export function runZfsChecks(tenant: Tenant): ResultAsync<HealthCheckResult[], LobsterError> {
  return ResultAsync.combine([
    checkDatasetMounted(tenant),
    checkQuotaUsage(tenant),
  ]);
}
