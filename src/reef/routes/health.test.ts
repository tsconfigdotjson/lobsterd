import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { LobsterError, TenantRegistry } from "../../types/index.js";

// Patch .openapi() on zod prototypes so schemas load without the OpenAPI registry
for (const Proto of [
  z.ZodObject.prototype,
  z.ZodString.prototype,
  z.ZodEnum.prototype,
  z.ZodNumber.prototype,
  z.ZodArray.prototype,
]) {
  if (!("openapi" in Proto)) {
    Object.defineProperty(Proto, "openapi", {
      value: function openapi() {
        return this;
      },
      writable: true,
      configurable: true,
    });
  }
}

class FakeOpenAPIHono extends Hono {
  openapi(
    route: { method: string; path: string },
    handler: (c: unknown) => unknown,
  ) {
    this.on(route.method, [route.path], handler as never);
  }
}

mock.module("@hono/zod-openapi", () => ({
  z,
  createRoute: (config: unknown) => config,
  OpenAPIHono: FakeOpenAPIHono,
}));

const TWO_TENANTS = {
  tenants: [{} as never, {} as never],
  nextCid: 5,
  nextSubnetIndex: 3,
  nextGatewayPort: 9002,
  nextJailUid: 10002,
} as TenantRegistry;

let registryResult: Result<TenantRegistry, LobsterError> = ok(TWO_TENANTS);

mock.module("../../config/loader.js", () => ({
  loadRegistry: () => registryResult,
}));

const { registerHealthRoutes } = await import("./health.js");

describe("GET /health", () => {
  test("returns ok with tenant count when registry loads", async () => {
    registryResult = ok(TWO_TENANTS);
    const app = new FakeOpenAPIHono();
    registerHealthRoutes(app as never);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.tenantCount).toBe(2);
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  test("returns tenantCount 0 when registry fails", async () => {
    registryResult = err({
      code: "CONFIG_NOT_FOUND",
      message: "no file",
    } satisfies LobsterError);
    const app = new FakeOpenAPIHono();
    registerHealthRoutes(app as never);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenantCount).toBe(0);
  });
});
