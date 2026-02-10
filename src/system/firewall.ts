import { okAsync, ResultAsync } from 'neverthrow';
import type { LobsterError } from '../types/index.js';
import { exec, execUnchecked } from './exec.js';

const CHAIN = 'LOBSTER';

function chainExists(): ResultAsync<boolean, LobsterError> {
  return execUnchecked(['iptables', '-L', CHAIN, '-n']).map((r) => r.exitCode === 0);
}

function jumpExists(): ResultAsync<boolean, LobsterError> {
  return execUnchecked(['iptables', '-C', 'OUTPUT', '-j', CHAIN]).map((r) => r.exitCode === 0);
}

export function initFirewall(): ResultAsync<void, LobsterError> {
  return chainExists().andThen((exists): ResultAsync<void, LobsterError> => {
    if (!exists) {
      return exec(['iptables', '-N', CHAIN]).map(() => undefined);
    }
    return okAsync(undefined);
  })
    .andThen(() => jumpExists())
    .andThen((exists): ResultAsync<void, LobsterError> => {
      if (!exists) {
        return exec(['iptables', '-A', 'OUTPUT', '-j', CHAIN]).map(() => undefined);
      }
      return okAsync(undefined);
    })
    .andThen(() =>
      // Root bypass — allow UID 0 through. Check first to be idempotent.
      execUnchecked(['iptables', '-C', CHAIN, '-m', 'owner', '--uid-owner', '0', '-j', 'RETURN'])
        .andThen((r): ResultAsync<void, LobsterError> => {
          if (r.exitCode !== 0) {
            return exec(['iptables', '-A', CHAIN, '-m', 'owner', '--uid-owner', '0', '-j', 'RETURN']).map(() => undefined);
          }
          return okAsync(undefined);
        }),
    );
}

export function addTenantRules(uid: number, port: number): ResultAsync<void, LobsterError> {
  // ACCEPT for owner UID on port
  return exec([
    'iptables', '-A', CHAIN,
    '-p', 'tcp', '--dport', String(port),
    '-m', 'owner', '--uid-owner', String(uid),
    '-j', 'ACCEPT',
  ]).map(() => undefined)
    // DROP for everyone else on port
    .andThen(() =>
      exec([
        'iptables', '-A', CHAIN,
        '-p', 'tcp', '--dport', String(port),
        '-j', 'DROP',
      ]).map(() => undefined),
    );
}

export function removeTenantRules(uid: number, port: number): ResultAsync<void, LobsterError> {
  // Remove ACCEPT rule — tolerate missing
  return execUnchecked([
    'iptables', '-D', CHAIN,
    '-p', 'tcp', '--dport', String(port),
    '-m', 'owner', '--uid-owner', String(uid),
    '-j', 'ACCEPT',
  ]).map(() => undefined)
    // Remove DROP rule — tolerate missing
    .andThen(() =>
      execUnchecked([
        'iptables', '-D', CHAIN,
        '-p', 'tcp', '--dport', String(port),
        '-j', 'DROP',
      ]).map(() => undefined),
    );
}
