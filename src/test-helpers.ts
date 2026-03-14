import type { Result, ResultAsync } from "neverthrow";
import { DEFAULT_CONFIG, EMPTY_REGISTRY } from "./config/defaults.js";
import type { LobsterdConfig, Tenant, TenantRegistry } from "./types/index.js";

export function makeTenant(overrides?: Partial<Tenant>): Tenant {
  return {
    name: "test-tenant",
    vmId: "vm-test-tenant",
    cid: 3,
    ipAddress: "10.0.0.2",
    hostIp: "10.0.0.1",
    tapDev: "tap-test-tenant",
    gatewayPort: 9000,
    overlayPath: "/var/lib/lobsterd/overlays/test-tenant",
    socketPath: "/var/lib/lobsterd/sockets/test-tenant.sock",
    vmPid: 12345,
    createdAt: "2025-01-01T00:00:00.000Z",
    status: "active",
    gatewayToken: "gw-token-test",
    jailUid: 10000,
    agentToken: "agent-token-test",
    suspendInfo: null,
    ...overrides,
  };
}

export function makeConfig(
  overrides?: Partial<LobsterdConfig>,
): LobsterdConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

export function makeRegistry(
  tenants?: Tenant[],
  overrides?: Partial<TenantRegistry>,
): TenantRegistry {
  return {
    ...EMPTY_REGISTRY,
    ...(tenants !== undefined ? { tenants } : {}),
    ...overrides,
  };
}

export async function unwrapOk<T, E>(result: ResultAsync<T, E>): Promise<T> {
  const r: Result<T, E> = await result;
  if (r.isErr()) {
    throw new Error(`Expected Ok but got Err: ${JSON.stringify(r.error)}`);
  }
  return r.value;
}

export async function unwrapErr<T, E>(result: ResultAsync<T, E>): Promise<E> {
  const r: Result<T, E> = await result;
  if (r.isOk()) {
    throw new Error(`Expected Err but got Ok: ${JSON.stringify(r.value)}`);
  }
  return r.error;
}
