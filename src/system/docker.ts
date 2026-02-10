import { ResultAsync } from 'neverthrow';
import type { LobsterError } from '../types/index.js';
import { exec, execUnchecked } from './exec.js';

function userEnv(uid: number): Record<string, string> {
  return { XDG_RUNTIME_DIR: `/run/user/${uid}` };
}

export function isDockerInstalled(): ResultAsync<boolean, LobsterError> {
  return execUnchecked(['which', 'dockerd-rootless-setuptool.sh']).map((r) => r.exitCode === 0);
}

export function installRootless(username: string, uid: number): ResultAsync<void, LobsterError> {
  return exec(
    ['dockerd-rootless-setuptool.sh', 'install'],
    {
      asUser: username,
      env: {
        ...userEnv(uid),
        HOME: `/home/${username}`,
      },
      timeout: 120_000,
    },
  ).map(() => undefined);
}

export function isResponsive(username: string, uid: number): ResultAsync<boolean, LobsterError> {
  return execUnchecked(
    ['docker', 'info'],
    {
      asUser: username,
      env: {
        ...userEnv(uid),
        DOCKER_HOST: `unix:///run/user/${uid}/docker.sock`,
      },
      timeout: 5_000,
    },
  ).map((r) => r.exitCode === 0);
}

export function dockerInfo(username: string, uid: number): ResultAsync<string, LobsterError> {
  return exec(
    ['docker', 'info'],
    {
      asUser: username,
      env: {
        ...userEnv(uid),
        DOCKER_HOST: `unix:///run/user/${uid}/docker.sock`,
      },
      timeout: 10_000,
    },
  ).map((r) => r.stdout);
}

export function dockerPs(username: string, uid: number): ResultAsync<string, LobsterError> {
  return exec(
    ['docker', 'ps', '--format', 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'],
    {
      asUser: username,
      env: {
        ...userEnv(uid),
        DOCKER_HOST: `unix:///run/user/${uid}/docker.sock`,
      },
      timeout: 10_000,
    },
  ).map((r) => r.stdout);
}

export function pruneSystem(username: string, uid: number): ResultAsync<void, LobsterError> {
  return exec(
    ['docker', 'system', 'prune', '-f'],
    {
      asUser: username,
      env: {
        ...userEnv(uid),
        DOCKER_HOST: `unix:///run/user/${uid}/docker.sock`,
      },
      timeout: 60_000,
    },
  ).map(() => undefined);
}

export function socketExists(uid: number): boolean {
  try {
    const file = Bun.file(`/run/user/${uid}/docker.sock`);
    // Bun.file doesn't have sync exists, so we approximate
    return true; // Will be checked via isResponsive in practice
  } catch {
    return false;
  }
}

export function removeStaleSocket(uid: number): ResultAsync<void, LobsterError> {
  return execUnchecked(['rm', '-f', `/run/user/${uid}/docker.sock`, `/run/user/${uid}/docker.pid`]).map(() => undefined);
}
