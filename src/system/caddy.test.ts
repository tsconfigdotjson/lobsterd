import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

const fetchSpy = spyOn(globalThis, "fetch");

// Mock exec so caddy.ts import resolves without side effects
mock.module("./exec.js", () => ({
  exec: () => {
    throw new Error("unexpected exec call");
  },
}));

const { addRoute, removeRoute, listRoutes, writeCaddyBaseConfig } =
  await import("./caddy.js");

const ADMIN = "http://localhost:2019";

afterEach(() => {
  fetchSpy.mockReset();
});

function okResponse(body?: unknown): Response {
  return new Response(body ? JSON.stringify(body) : "", {
    status: 200,
    statusText: "OK",
  });
}

function errResponse(status: number, text: string): Response {
  return new Response(text, { status, statusText: "Error" });
}

function callAt(idx: number): {
  url: string;
  init: RequestInit;
} {
  const c = fetchSpy.mock.calls[idx];
  return { url: c[0] as string, init: c[1] as RequestInit };
}

function bodyAt(idx: number): Record<string, unknown> {
  return JSON.parse(callAt(idx).init.body as string);
}

describe("addRoute", () => {
  test("sends 2 POSTs: ws route then http route", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());
    fetchSpy.mockResolvedValueOnce(okResponse());

    const result = await addRoute(
      ADMIN,
      "myapp",
      "example.com",
      "10.0.0.2",
      8080,
    );
    expect(result.isOk()).toBe(true);

    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // First call: ws route
    const ws = callAt(0);
    expect(ws.url).toBe(`${ADMIN}/config/apps/http/servers/lobster/routes`);
    expect(ws.init.method).toBe("POST");
    const wsBody = bodyAt(0);
    expect(wsBody["@id"]).toBe("lobster-myapp-ws");

    // Second call: http route
    const http = callAt(1);
    expect(http.init.method).toBe("POST");
    const httpBody = bodyAt(1);
    expect(httpBody["@id"]).toBe("lobster-myapp");
  });

  test("returns Err when first POST fails", async () => {
    fetchSpy.mockResolvedValueOnce(errResponse(500, "server error"));

    const result = await addRoute(
      ADMIN,
      "myapp",
      "example.com",
      "10.0.0.2",
      8080,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("CADDY_API_ERROR");
  });
});

describe("removeRoute", () => {
  test("sends 2 DELETEs: ws then http", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());
    fetchSpy.mockResolvedValueOnce(okResponse());

    const result = await removeRoute(ADMIN, "myapp");
    expect(result.isOk()).toBe(true);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(callAt(0).url).toBe(`${ADMIN}/id/lobster-myapp-ws`);
    expect(callAt(0).init.method).toBe("DELETE");
    expect(callAt(1).url).toBe(`${ADMIN}/id/lobster-myapp`);
    expect(callAt(1).init.method).toBe("DELETE");
  });

  test("succeeds even if DELETE returns error (orElse)", async () => {
    fetchSpy.mockResolvedValueOnce(errResponse(404, "not found"));
    fetchSpy.mockResolvedValueOnce(errResponse(404, "not found"));

    const result = await removeRoute(ADMIN, "gone");
    expect(result.isOk()).toBe(true);
  });
});

describe("listRoutes", () => {
  test("sends GET and returns routes array", async () => {
    const routes = [{ "@id": "lobster-foo" }, { "@id": "lobster-bar" }];
    fetchSpy.mockResolvedValueOnce(okResponse(routes));

    const result = await listRoutes(ADMIN);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(routes);

    expect(callAt(0).init.method).toBe("GET");
    expect(callAt(0).url).toBe(
      `${ADMIN}/config/apps/http/servers/lobster/routes`,
    );
  });
});

describe("writeCaddyBaseConfig", () => {
  test("sends POST /load without TLS", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());

    const result = await writeCaddyBaseConfig(ADMIN, "example.com");
    expect(result.isOk()).toBe(true);

    expect(callAt(0).init.method).toBe("POST");
    expect(callAt(0).url).toBe(`${ADMIN}/load`);

    const body = bodyAt(0);
    const apps = body.apps as Record<
      string,
      Record<string, Record<string, Record<string, unknown>>>
    >;
    expect(apps.tls).toBeUndefined();
    expect(apps.http.servers.lobster.automatic_https).toEqual({
      disable_redirects: false,
    });
  });

  test("sends POST /load with TLS config", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());

    const result = await writeCaddyBaseConfig(ADMIN, "example.com", {
      certPath: "/cert.pem",
      keyPath: "/key.pem",
    });
    expect(result.isOk()).toBe(true);

    const body = bodyAt(0);
    const apps = body.apps as Record<string, Record<string, unknown>>;
    expect(apps.tls).toBeDefined();
    const tls = apps.tls as Record<string, Record<string, unknown>>;
    const loadFiles = (tls.certificates as Record<string, unknown[]>)
      .load_files as Record<string, string>[];
    expect(loadFiles[0].certificate).toBe("/cert.pem");
    expect(loadFiles[0].key).toBe("/key.pem");
  });

  test("returns CADDY_API_ERROR on fetch failure", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("connection refused"));

    const result = await writeCaddyBaseConfig(ADMIN, "example.com");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("CADDY_API_ERROR");
  });
});
