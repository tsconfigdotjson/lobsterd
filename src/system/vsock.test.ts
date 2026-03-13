import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import {
  acquireHold,
  ensureGateway,
  getActiveConnections,
  getCronSchedules,
  getHeartbeatSchedule,
  getLogs,
  getStats,
  healthPing,
  injectSecrets,
  pokeCron,
  releaseHold,
  setGuestTime,
  waitForAgent,
} from "./vsock.js";

let server: Server;
let port: number;
let handler: (data: string) => string;

beforeAll(async () => {
  server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      if (buf.includes("\n")) {
        const response = handler(buf.trim());
        socket.end(response);
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") {
        port = addr.port;
      }
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

describe("healthPing", () => {
  test("returns true when agent responds with PONG", async () => {
    handler = () => "PONG\n";
    const result = await healthPing("127.0.0.1", port, "test-token");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(true);
  });

  test("returns false when agent responds with ERR", async () => {
    handler = () => "ERR";
    const result = await healthPing("127.0.0.1", port, "test-token");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(false);
  });
});

describe("injectSecrets", () => {
  test("returns Ok when agent acknowledges with ACK", async () => {
    handler = () => "ACK\n";
    const result = await injectSecrets(
      "127.0.0.1",
      port,
      { MY_SECRET: "value" },
      "test-token",
    );
    expect(result.isOk()).toBe(true);
  });

  test("returns Err when agent responds with rejection", async () => {
    handler = () => "REJECTED";
    const result = await injectSecrets(
      "127.0.0.1",
      port,
      { MY_SECRET: "value" },
      "test-token",
    );
    expect(result.isErr()).toBe(true);
  });
});

describe("getStats", () => {
  test("parses JSON response into GuestStats", async () => {
    handler = () =>
      JSON.stringify({
        gatewayPid: 1,
        memoryKb: 1024,
        activeConnections: 0,
      });
    const result = await getStats("127.0.0.1", port, "test-token");
    expect(result.isOk()).toBe(true);
    const stats = result._unsafeUnwrap();
    expect(stats.gatewayPid).toBe(1);
    expect(stats.memoryKb).toBe(1024);
    expect(stats.activeConnections).toBe(0);
  });
});

describe("getCronSchedules", () => {
  test("parses schedules array from response", async () => {
    handler = () =>
      JSON.stringify({
        schedules: [{ id: "1", name: "test", nextRunAtMs: 999 }],
      });
    const result = await getCronSchedules("127.0.0.1", port, "test-token");
    expect(result.isOk()).toBe(true);
    const schedules = result._unsafeUnwrap();
    expect(schedules).toHaveLength(1);
    expect(schedules[0].id).toBe("1");
    expect(schedules[0].name).toBe("test");
    expect(schedules[0].nextRunAtMs).toBe(999);
  });
});

describe("getActiveConnections", () => {
  test("parses tcp/cron/hold counts from response", async () => {
    handler = () => JSON.stringify({ tcp: 1, cron: 2, hold: 3 });
    const result = await getActiveConnections("127.0.0.1", port, "test-token");
    expect(result.isOk()).toBe(true);
    const connections = result._unsafeUnwrap();
    expect(connections.tcp).toBe(1);
    expect(connections.cron).toBe(2);
    expect(connections.hold).toBe(3);
  });
});

describe("setGuestTime", () => {
  test("returns Ok when agent confirms with ok:true", async () => {
    handler = () => JSON.stringify({ ok: true });
    const result = await setGuestTime("127.0.0.1", port, "test-token");
    expect(result.isOk()).toBe(true);
  });

  test("returns Err when agent responds with ok:false", async () => {
    handler = () => JSON.stringify({ ok: false, error: "denied" });
    const result = await setGuestTime("127.0.0.1", port, "test-token");
    expect(result.isErr()).toBe(true);
  });
});

describe("pokeCron", () => {
  test("returns Ok when response has no error field", async () => {
    handler = () => JSON.stringify({});
    const result = await pokeCron("127.0.0.1", port, "test-token");
    expect(result.isOk()).toBe(true);
  });

  test("returns Err when response has error field", async () => {
    handler = () => JSON.stringify({ error: "failed" });
    const result = await pokeCron("127.0.0.1", port, "test-token");
    expect(result.isErr()).toBe(true);
  });
});

describe("getHeartbeatSchedule", () => {
  test("returns HeartbeatScheduleInfo when enabled", async () => {
    handler = () =>
      JSON.stringify({
        enabled: true,
        intervalMs: 60000,
        nextBeatAtMs: 999,
      });
    const result = await getHeartbeatSchedule("127.0.0.1", port, "test-token");
    expect(result.isOk()).toBe(true);
    const info = result._unsafeUnwrap();
    expect(info).not.toBeNull();
    expect(info?.enabled).toBe(true);
    expect(info?.intervalMs).toBe(60000);
    expect(info?.nextBeatAtMs).toBe(999);
  });

  test("returns null when heartbeat is disabled", async () => {
    handler = () => JSON.stringify({ enabled: false });
    const result = await getHeartbeatSchedule("127.0.0.1", port, "test-token");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });
});

describe("ensureGateway", () => {
  test("returns Ok when agent responds with ok:true", async () => {
    handler = () => JSON.stringify({ ok: true });
    const result = await ensureGateway("127.0.0.1", port, "test-token");
    expect(result.isOk()).toBe(true);
  });

  test("returns Err when agent responds with error", async () => {
    handler = () => JSON.stringify({ error: "failed" });
    const result = await ensureGateway("127.0.0.1", port, "test-token");
    expect(result.isErr()).toBe(true);
  });
});

describe("acquireHold", () => {
  test("returns Ok when hold is acquired", async () => {
    handler = () => JSON.stringify({ ok: true });
    const result = await acquireHold(
      "127.0.0.1",
      port,
      "test-token",
      "hold-1",
      30000,
    );
    expect(result.isOk()).toBe(true);
  });

  test("returns Err when hold is rejected", async () => {
    handler = () => JSON.stringify({ ok: false, error: "rejected" });
    const result = await acquireHold(
      "127.0.0.1",
      port,
      "test-token",
      "hold-1",
      30000,
    );
    expect(result.isErr()).toBe(true);
  });
});

describe("releaseHold", () => {
  test("returns Ok when hold is released", async () => {
    handler = () => JSON.stringify({ ok: true });
    const result = await releaseHold("127.0.0.1", port, "test-token", "hold-1");
    expect(result.isOk()).toBe(true);
  });
});

describe("getLogs", () => {
  test("returns raw response string", async () => {
    handler = () => "log line 1\nlog line 2";
    const result = await getLogs("127.0.0.1", port, "test-token");
    expect(result.isOk()).toBe(true);
    const logs = result._unsafeUnwrap();
    expect(logs).toContain("log line 1");
    expect(logs).toContain("log line 2");
  });
});

describe("waitForAgent", () => {
  test("returns Ok when agent is reachable", async () => {
    const result = await waitForAgent("127.0.0.1", port, 5000);
    expect(result.isOk()).toBe(true);
  });
});
