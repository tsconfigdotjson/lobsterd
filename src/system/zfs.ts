import { ResultAsync } from 'neverthrow';
import type { LobsterError } from '../types/index.js';
import { exec, execUnchecked } from './exec.js';

export function isZfsAvailable(): ResultAsync<boolean, LobsterError> {
  return execUnchecked(['zpool', 'status']).map((r) => r.exitCode === 0);
}

export function datasetExists(dataset: string): ResultAsync<boolean, LobsterError> {
  return execUnchecked(['zfs', 'list', '-H', dataset]).map((r) => r.exitCode === 0);
}

export function createDataset(
  dataset: string,
  opts: { mountpoint?: string; quota?: string; compression?: string } = {},
): ResultAsync<void, LobsterError> {
  const args = ['zfs', 'create'];
  if (opts.mountpoint) args.push('-o', `mountpoint=${opts.mountpoint}`);
  if (opts.quota) args.push('-o', `quota=${opts.quota}`);
  if (opts.compression) args.push('-o', `compression=${opts.compression}`);
  args.push(dataset);
  return exec(args).map(() => undefined);
}

export function destroyDataset(dataset: string, recursive = false): ResultAsync<void, LobsterError> {
  const args = ['zfs', 'destroy'];
  if (recursive) args.push('-r');
  args.push(dataset);
  return exec(args).map(() => undefined);
}

export function snapshot(dataset: string, snapName: string): ResultAsync<void, LobsterError> {
  return exec(['zfs', 'snapshot', `${dataset}@${snapName}`]).map(() => undefined);
}

export function listSnapshots(dataset: string): ResultAsync<string[], LobsterError> {
  return exec([
    'zfs', 'list', '-H', '-t', 'snapshot', '-o', 'name', '-r', dataset,
  ]).map((r) =>
    r.stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0),
  );
}

export function destroySnapshot(snapName: string): ResultAsync<void, LobsterError> {
  return exec(['zfs', 'destroy', snapName]).map(() => undefined);
}

export interface ZfsUsage {
  used: string;
  available: string;
  quota: string;
  mountpoint: string;
}

export function getUsage(dataset: string): ResultAsync<ZfsUsage, LobsterError> {
  return exec([
    'zfs', 'get', '-H', '-o', 'value', 'used,available,quota,mountpoint', dataset,
  ]).map((r) => {
    const [used, available, quota, mountpoint] = r.stdout.trim().split('\n');
    return { used, available, quota, mountpoint };
  });
}

export function isMounted(dataset: string): ResultAsync<boolean, LobsterError> {
  return exec([
    'zfs', 'get', '-H', '-o', 'value', 'mounted', dataset,
  ]).map((r) => r.stdout.trim() === 'yes');
}

export function mount(dataset: string): ResultAsync<void, LobsterError> {
  return exec(['zfs', 'mount', dataset]).map(() => undefined);
}
