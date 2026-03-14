import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { DEFAULT_CONFIG, EMPTY_REGISTRY } from "./defaults.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

let fileExistsMock: ReturnType<typeof mock>;
let fileJsonMock: ReturnType<typeof mock>;
let fileTextMock: ReturnType<typeof mock>;
let bunWriteMock: ReturnType<typeof spyOn>;
let bunSpawnSpy: ReturnType<typeof spyOn>;

// spyOn node:fs functions so the full module stays intact for other test files
const chmodSyncSpy = spyOn(fs, "chmodSync").mockImplementation(() => {});
const openSyncSpy = spyOn(fs, "openSync").mockReturnValue(99 as never);
const closeSyncSpy = spyOn(fs, "closeSync").mockImplementation(() => {});
const unlinkSyncSpy = spyOn(fs, "unlinkSync").mockImplementation(() => {});
const writeFileSyncSpy = spyOn(fs, "writeFileSync").mockImplementation(
  () => {},
);

fileExistsMock = mock();
fileJsonMock = mock();
fileTextMock = mock();

spyOn(Bun, "file").mockImplementation(
  () =>
    ({
      exists: fileExistsMock,
      json: fileJsonMock,
      text: fileTextMock,
    }) as never,
);

bunWriteMock = spyOn(Bun, "write").mockResolvedValue(0);
bunSpawnSpy = spyOn(Bun, "spawn").mockImplementation(
  () =>
    ({
      exited: Promise.resolve(0),
      exitCode: 0,
    }) as never,
);

const { loadConfig, saveConfig, loadRegistry, saveRegistry } = await import(
  "./loader.js"
);

afterEach(() => {
  fileExistsMock.mockReset();
  fileJsonMock.mockReset();
  fileTextMock.mockReset();
  bunWriteMock.mockClear();
  bunSpawnSpy.mockClear();
  chmodSyncSpy.mockClear();
  openSyncSpy.mockReset();
  openSyncSpy.mockReturnValue(99 as never);
  closeSyncSpy.mockClear();
  unlinkSyncSpy.mockClear();
  writeFileSyncSpy.mockClear();
});

// ── loadConfig ───────────────────────────────────────────────────────────────

describe("loadConfig", () => {
  test("returns defaults when file does not exist", async () => {
    fileExistsMock.mockResolvedValue(false);

    const result = await loadConfig();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(DEFAULT_CONFIG);
  });

  test("parses valid JSON config", async () => {
    fileExistsMock.mockResolvedValue(true);
    fileJsonMock.mockResolvedValue(DEFAULT_CONFIG);

    const result = await loadConfig();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(DEFAULT_CONFIG);
  });

  test("returns CONFIG_INVALID for bad data", async () => {
    fileExistsMock.mockResolvedValue(true);
    fileJsonMock.mockResolvedValue({ jailer: "not-an-object" });

    const result = await loadConfig();
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("CONFIG_INVALID");
  });
});

// ── saveConfig ───────────────────────────────────────────────────────────────

describe("saveConfig", () => {
  test("performs atomic write: Bun.write tmp, chmod, mv", async () => {
    const result = await saveConfig(DEFAULT_CONFIG);
    expect(result.isOk()).toBe(true);

    // Bun.write called with tmp path
    expect(bunWriteMock).toHaveBeenCalledTimes(1);
    const writePath = bunWriteMock.mock.calls[0][0] as string;
    expect(writePath).toContain(".tmp.");

    // chmod called
    expect(chmodSyncSpy).toHaveBeenCalledTimes(1);

    // mv called
    expect(bunSpawnSpy).toHaveBeenCalledTimes(1);
    const mvArgs = bunSpawnSpy.mock.calls[0][0] as string[];
    expect(mvArgs[0]).toBe("mv");
  });
});

// ── loadRegistry ─────────────────────────────────────────────────────────────

describe("loadRegistry", () => {
  test("returns empty registry when file does not exist", async () => {
    fileExistsMock.mockResolvedValue(false);

    const result = await loadRegistry();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(EMPTY_REGISTRY);
  });

  test("parses valid registry JSON", async () => {
    fileExistsMock.mockResolvedValue(true);
    fileJsonMock.mockResolvedValue(EMPTY_REGISTRY);

    const result = await loadRegistry();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(EMPTY_REGISTRY);
  });

  test("returns CONFIG_INVALID for bad registry data", async () => {
    fileExistsMock.mockResolvedValue(true);
    fileJsonMock.mockResolvedValue({ tenants: "not-array" });

    const result = await loadRegistry();
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("CONFIG_INVALID");
  });
});

// ── saveRegistry ─────────────────────────────────────────────────────────────

describe("saveRegistry", () => {
  test("acquires lock, writes, then releases lock", async () => {
    const result = await saveRegistry(EMPTY_REGISTRY);
    expect(result.isOk()).toBe(true);

    // Lock: openSync + writeFileSync + closeSync
    expect(openSyncSpy).toHaveBeenCalledTimes(1);
    const lockPath = openSyncSpy.mock.calls[0][0] as string;
    expect(lockPath).toContain("registry.lock");

    // Write tmp + chmod + mv
    expect(bunWriteMock).toHaveBeenCalledTimes(1);
    expect(chmodSyncSpy).toHaveBeenCalledTimes(1);
    expect(bunSpawnSpy).toHaveBeenCalledTimes(1);

    // Release: unlinkSync called for lock
    expect(unlinkSyncSpy).toHaveBeenCalled();
  });
});
