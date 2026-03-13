import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { okAsync } from "neverthrow";
import type { ExecResult, LobsterError } from "../types/index.js";
import { generateWatchUnit } from "./systemd.js";

// ── generateWatchUnit (existing tests) ───────────────────────────────────────

describe("generateWatchUnit", () => {
  const unit = generateWatchUnit(
    "/usr/local/bin/bun",
    "/opt/lobsterd/src/index.tsx",
  );

  test("ExecStart contains bun path", () => {
    expect(unit).toContain("ExecStart=/usr/local/bin/bun");
  });

  test("has [Unit] section", () => {
    expect(unit).toContain("[Unit]");
  });

  test("has [Service] section", () => {
    expect(unit).toContain("[Service]");
  });

  test("has [Install] section", () => {
    expect(unit).toContain("[Install]");
  });

  test("has SyslogIdentifier", () => {
    expect(unit).toContain("SyslogIdentifier=lobsterd-watch");
  });

  test("has Restart=on-failure", () => {
    expect(unit).toContain("Restart=on-failure");
  });
});

// ── Mocked tests for installService, enableAndStart, stopAndRemove ───────────

const execMock = mock();
const execUncheckedMock = mock();

mock.module("./exec.js", () => ({
  exec: (...args: unknown[]) => execMock(...args),
  execUnchecked: (...args: unknown[]) => execUncheckedMock(...args),
}));

const bunWriteSpy = spyOn(Bun, "write").mockResolvedValue(0);
const chmodSyncSpy = spyOn(fs, "chmodSync").mockImplementation(() => {});
const unlinkSyncSpy = spyOn(fs, "unlinkSync").mockImplementation(() => {});

const { installService, enableAndStartService, stopAndRemoveService } =
  await import("./systemd.js");

function okExec() {
  return okAsync<ExecResult, LobsterError>({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
}

afterEach(() => {
  execMock.mockReset();
  execUncheckedMock.mockReset();
  bunWriteSpy.mockClear();
  chmodSyncSpy.mockClear();
  unlinkSyncSpy.mockClear();
});

describe("installService", () => {
  test("writes unit file, chmods, then runs daemon-reload", async () => {
    execMock.mockReturnValueOnce(okExec());

    const result = await installService("lobsterd-watch", "[Unit]\ntest");
    expect(result.isOk()).toBe(true);

    // Bun.write to unit path
    expect(bunWriteSpy).toHaveBeenCalledTimes(1);
    const writeArgs = bunWriteSpy.mock.calls[0] as unknown as [string, string];
    expect(writeArgs[0]).toBe("/etc/systemd/system/lobsterd-watch.service");
    expect(writeArgs[1]).toBe("[Unit]\ntest");

    // chmod 0644
    expect(chmodSyncSpy).toHaveBeenCalledTimes(1);
    const chmodArgs = chmodSyncSpy.mock.calls[0] as unknown as [string, number];
    expect(chmodArgs[1]).toBe(0o644);

    // daemon-reload
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0][0]).toEqual(["systemctl", "daemon-reload"]);
  });
});

describe("enableAndStartService", () => {
  test("runs systemctl enable then restart", async () => {
    execMock.mockReturnValueOnce(okExec());
    execMock.mockReturnValueOnce(okExec());

    const result = await enableAndStartService("lobsterd-watch");
    expect(result.isOk()).toBe(true);

    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock.mock.calls[0][0]).toEqual([
      "systemctl",
      "enable",
      "lobsterd-watch",
    ]);
    expect(execMock.mock.calls[1][0]).toEqual([
      "systemctl",
      "restart",
      "lobsterd-watch",
    ]);
  });
});

describe("stopAndRemoveService", () => {
  test("stops, disables, unlinks unit, daemon-reloads", async () => {
    execUncheckedMock.mockReturnValueOnce(okExec()); // stop
    execUncheckedMock.mockReturnValueOnce(okExec()); // disable
    execUncheckedMock.mockReturnValueOnce(okExec()); // daemon-reload

    const result = await stopAndRemoveService("lobsterd-watch");
    expect(result.isOk()).toBe(true);

    expect(execUncheckedMock).toHaveBeenCalledTimes(3);
    expect(execUncheckedMock.mock.calls[0][0]).toEqual([
      "systemctl",
      "stop",
      "lobsterd-watch",
    ]);
    expect(execUncheckedMock.mock.calls[1][0]).toEqual([
      "systemctl",
      "disable",
      "lobsterd-watch",
    ]);

    // unlinkSync called for unit file
    expect(unlinkSyncSpy).toHaveBeenCalled();

    // daemon-reload
    expect(execUncheckedMock.mock.calls[2][0]).toEqual([
      "systemctl",
      "daemon-reload",
    ]);
  });
});
