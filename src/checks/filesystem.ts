import { ResultAsync, ok } from 'neverthrow';
import type { Tenant, HealthCheckResult, LobsterError } from '../types/index.js';
import { execUnchecked } from '../system/exec.js';

function dirExists(path: string): ResultAsync<boolean, LobsterError> {
  return execUnchecked(['test', '-d', path]).map((r) => r.exitCode === 0);
}

function checkOwnership(path: string, uid: number, gid: number): ResultAsync<boolean, LobsterError> {
  return execUnchecked(['stat', '-c', '%u:%g', path]).map((r) => {
    if (r.exitCode !== 0) return false;
    return r.stdout.trim() === `${uid}:${gid}`;
  });
}

export function checkHomeDir(tenant: Tenant): ResultAsync<HealthCheckResult, LobsterError> {
  return dirExists(tenant.homePath).andThen((exists) => {
    if (!exists) {
      return ok({
        check: 'fs.home',
        status: 'failed' as const,
        message: `Home directory ${tenant.homePath} does not exist`,
      });
    }
    return checkOwnership(tenant.homePath, tenant.uid, tenant.gid).map((correct) => ({
      check: 'fs.home',
      status: correct ? 'ok' : 'degraded',
      message: correct ? 'Home directory OK' : `Home directory ${tenant.homePath} has wrong ownership`,
    } as HealthCheckResult));
  });
}

export function checkOpenclawDir(tenant: Tenant): ResultAsync<HealthCheckResult, LobsterError> {
  const dirPath = `${tenant.homePath}/.openclaw`;
  return dirExists(dirPath).map((exists) => ({
    check: 'fs.openclaw',
    status: exists ? 'ok' : 'failed',
    message: exists ? '.openclaw directory exists' : `.openclaw directory missing at ${dirPath}`,
  } as HealthCheckResult));
}

export function checkXdgDirs(tenant: Tenant): ResultAsync<HealthCheckResult, LobsterError> {
  const dirs = [
    `${tenant.homePath}/.config`,
    `${tenant.homePath}/.local/share`,
  ];
  return ResultAsync.combine(
    dirs.map((d) => dirExists(d)),
  ).map((results) => {
    const allExist = results.every(Boolean);
    return {
      check: 'fs.xdg',
      status: allExist ? 'ok' : 'degraded',
      message: allExist ? 'XDG directories exist' : 'Some XDG directories are missing',
    } as HealthCheckResult;
  });
}

export function checkHomeDirPermissions(tenant: Tenant): ResultAsync<HealthCheckResult, LobsterError> {
  return execUnchecked(['stat', '-c', '%a', tenant.homePath]).map((r) => {
    if (r.exitCode !== 0) {
      return {
        check: 'fs.home-perms',
        status: 'failed' as const,
        message: `Cannot stat home directory ${tenant.homePath}`,
      };
    }
    const mode = r.stdout.trim();
    return {
      check: 'fs.home-perms',
      status: mode === '700' ? 'ok' : 'degraded',
      message: mode === '700'
        ? 'Home directory permissions OK (700)'
        : `Home directory ${tenant.homePath} has mode ${mode}, expected 700`,
    } as HealthCheckResult;
  });
}

export function runFilesystemChecks(tenant: Tenant): ResultAsync<HealthCheckResult[], LobsterError> {
  return ResultAsync.combine([
    checkHomeDir(tenant),
    checkHomeDirPermissions(tenant),
    checkOpenclawDir(tenant),
    checkXdgDirs(tenant),
  ]);
}
