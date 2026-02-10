import { ResultAsync, ok, err } from 'neverthrow';
import { openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import type { LobsterError } from '../types/index.js';
import { exec, execUnchecked } from './exec.js';

// ── Lockfile helpers ────────────────────────────────────────────────────────

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 100;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < LOCK_TIMEOUT_MS) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (e: any) {
      if (e.code === 'EEXIST') {
        try {
          const content = await Bun.file(lockPath).text();
          const pid = parseInt(content.trim(), 10);
          if (!isNaN(pid) && !isPidAlive(pid)) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          // Lock file disappeared — retry
        }
        await Bun.sleep(LOCK_POLL_MS);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Timed out acquiring lock ${lockPath} after ${LOCK_TIMEOUT_MS}ms`);
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Already removed
  }
}

// ── User management ─────────────────────────────────────────────────────────

export function checkUserExists(name: string): ResultAsync<boolean, LobsterError> {
  return execUnchecked(['id', '-u', name]).map((r) => r.exitCode === 0);
}

export function createUser(
  name: string,
  uid: number,
  homePath: string,
): ResultAsync<void, LobsterError> {
  return exec([
    'useradd',
    '--uid', String(uid),
    '--home-dir', homePath,
    '--no-create-home', // ZFS mountpoint is the home dir
    '--shell', '/usr/sbin/nologin',
    name,
  ]).map(() => undefined);
}

export function deleteUser(name: string): ResultAsync<void, LobsterError> {
  return exec(['userdel', '--force', name]).map(() => undefined);
}

export function ensureSubuidRange(
  name: string,
  start: number,
  count: number = 65536,
): ResultAsync<void, LobsterError> {
  const entry = `${name}:${start}:${count}`;
  return ResultAsync.fromPromise(
    (async () => {
      for (const file of ['/etc/subuid', '/etc/subgid']) {
        const lockPath = `${file}.lobsterd.lock`;
        await acquireLock(lockPath);
        try {
          const content = await Bun.file(file).text().catch(() => '');
          if (!content.includes(`${name}:`)) {
            await Bun.write(file, content.trimEnd() + '\n' + entry + '\n');
          }
        } finally {
          releaseLock(lockPath);
        }
      }
    })(),
    (e) => ({ code: 'LOCK_FAILED' as const, message: `Failed to configure subuid/subgid for ${name}`, cause: e }),
  );
}

export function enableLinger(name: string): ResultAsync<void, LobsterError> {
  return exec(['loginctl', 'enable-linger', name]).map(() => undefined);
}

export function waitForUserSession(uid: number, timeoutMs: number = 10_000): ResultAsync<void, LobsterError> {
  const runtimeDir = `/run/user/${uid}`;
  return ResultAsync.fromPromise(
    (async () => {
      const { existsSync } = await import('node:fs');
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (existsSync(`${runtimeDir}/systemd`)) return;
        await Bun.sleep(200);
      }
      throw new Error(`User session for uid ${uid} did not appear within ${timeoutMs}ms`);
    })(),
    (e) => ({ code: 'SESSION_TIMEOUT' as const, message: String(e instanceof Error ? e.message : e) }),
  );
}

export function disableLinger(name: string): ResultAsync<void, LobsterError> {
  return exec(['loginctl', 'disable-linger', name]).map(() => undefined);
}

export function isLingerEnabled(name: string): ResultAsync<boolean, LobsterError> {
  return execUnchecked(['loginctl', 'show-user', name, '--property=Linger']).map(
    (r) => r.exitCode === 0 && r.stdout.trim() === 'Linger=yes',
  );
}
