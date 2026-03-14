import { describe, expect, test } from "bun:test";
import {
  CERTS_DIR,
  CONFIG_DIR,
  CONFIG_PATH,
  DEFAULT_CONFIG,
  EMPTY_REGISTRY,
  JAILER_BASE,
  KERNELS_DIR,
  LOBSTERD_BASE,
  ORIGIN_CERT_PATH,
  ORIGIN_KEY_PATH,
  OVERLAYS_DIR,
  REGISTRY_PATH,
  SNAPSHOTS_DIR,
  SOCKETS_DIR,
} from "./defaults.js";
import { lobsterdConfigSchema, tenantRegistrySchema } from "./schema.js";

describe("DEFAULT_CONFIG", () => {
  test("passes lobsterdConfigSchema", () => {
    const result = lobsterdConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
  });
});

describe("EMPTY_REGISTRY", () => {
  test("passes tenantRegistrySchema", () => {
    const result = tenantRegistrySchema.safeParse(EMPTY_REGISTRY);
    expect(result.success).toBe(true);
  });

  test("nextGatewayPort equals gatewayPortStart", () => {
    expect(EMPTY_REGISTRY.nextGatewayPort).toBe(
      DEFAULT_CONFIG.network.gatewayPortStart,
    );
  });

  test("nextJailUid equals uidStart", () => {
    expect(EMPTY_REGISTRY.nextJailUid).toBe(DEFAULT_CONFIG.jailer.uidStart);
  });
});

describe("path constants", () => {
  test.each([
    ["CONFIG_DIR", CONFIG_DIR],
    ["CONFIG_PATH", CONFIG_PATH],
    ["REGISTRY_PATH", REGISTRY_PATH],
    ["LOBSTERD_BASE", LOBSTERD_BASE],
    ["OVERLAYS_DIR", OVERLAYS_DIR],
    ["SOCKETS_DIR", SOCKETS_DIR],
    ["KERNELS_DIR", KERNELS_DIR],
    ["JAILER_BASE", JAILER_BASE],
    ["SNAPSHOTS_DIR", SNAPSHOTS_DIR],
    ["CERTS_DIR", CERTS_DIR],
    ["ORIGIN_CERT_PATH", ORIGIN_CERT_PATH],
    ["ORIGIN_KEY_PATH", ORIGIN_KEY_PATH],
  ])("%s starts with /", (_name, path) => {
    expect(path.startsWith("/")).toBe(true);
  });
});
