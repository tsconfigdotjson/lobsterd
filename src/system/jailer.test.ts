import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import type { ExecResult, LobsterError } from "../types/index.js";
import * as execMod from "./exec.js";
import {
  buildJailerArgs,
  cleanupChroot,
  getApiSocketPath,
  getChrootRoot,
  linkChrootFiles,
} from "./jailer.js";

const chrootBaseDir = "/var/lib/lobsterd/jailer";
const vmId = "vm-test-tenant";

describe("getChrootRoot", () => {
  test("returns correct path", () => {
    expect(getChrootRoot(chrootBaseDir, vmId)).toBe(
      "/var/lib/lobsterd/jailer/firecracker/vm-test-tenant/root",
    );
  });
});

describe("getApiSocketPath", () => {
  test("appends /api.socket to chroot root", () => {
    expect(getApiSocketPath(chrootBaseDir, vmId)).toBe(
      "/var/lib/lobsterd/jailer/firecracker/vm-test-tenant/root/api.socket",
    );
  });
});

describe("buildJailerArgs", () => {
  const jailerConfig = {
    binaryPath: "/usr/local/bin/jailer",
    chrootBaseDir,
    uidStart: 10000,
  };
  const fcBinary = "/usr/local/bin/firecracker";

  test("without cgroups has required args", () => {
    const args = buildJailerArgs(jailerConfig, fcBinary, vmId, 10001);
    expect(args).toContain("--id");
    expect(args).toContain(vmId);
    expect(args).toContain("--exec-file");
    expect(args).toContain(fcBinary);
    expect(args).toContain("--uid");
    expect(args).toContain("10001");
    expect(args).toContain("--gid");
    expect(args).toContain("10001");
    expect(args).toContain("--");
    expect(args).toContain("--api-sock");
    expect(args).toContain("api.socket");
    expect(args).not.toContain("--cgroup");
  });

  test("with cgroups includes --cgroup", () => {
    const args = buildJailerArgs(jailerConfig, fcBinary, vmId, 10001, {
      memLimitBytes: 1073741824,
      cpuQuotaUs: 200000,
      cpuPeriodUs: 100000,
    });
    expect(args).toContain("--cgroup");
    // -- separator and api-sock should still be at the end
    const dashIndex = args.indexOf("--");
    expect(dashIndex).toBeGreaterThan(-1);
    expect(args[dashIndex + 1]).toBe("--api-sock");
  });
});

describe("linkChrootFiles", () => {
  let execSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    execSpy = spyOn(execMod, "exec");
  });

  afterEach(() => {
    execSpy.mockRestore();
  });

  test("chains 4 exec calls and returns Ok on success", async () => {
    const okResult: ExecResult = { exitCode: 0, stdout: "", stderr: "" };

    execSpy
      .mockReturnValueOnce(okAsync(okResult)) // ln kernel
      .mockReturnValueOnce(okAsync(okResult)) // ln rootfs
      .mockReturnValueOnce(okAsync(okResult)) // ln overlay
      .mockReturnValueOnce(okAsync(okResult)); // chown overlay

    const result = await linkChrootFiles(
      chrootBaseDir,
      vmId,
      "/boot/vmlinux",
      "/var/lib/lobsterd/rootfs.ext4",
      "/var/lib/lobsterd/overlays/test.ext4",
      10001,
    );

    expect(result.isOk()).toBe(true);
    expect(execSpy).toHaveBeenCalledTimes(4);
  });

  test("returns Err with JAILER_SETUP_FAILED when first exec fails", async () => {
    const error: LobsterError = {
      code: "EXEC_FAILED",
      message: "ln failed",
    };
    execSpy.mockReturnValueOnce(errAsync(error));

    const result = await linkChrootFiles(
      chrootBaseDir,
      vmId,
      "/boot/vmlinux",
      "/var/lib/lobsterd/rootfs.ext4",
      "/var/lib/lobsterd/overlays/test.ext4",
      10001,
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("JAILER_SETUP_FAILED");
  });
});

describe("cleanupChroot", () => {
  let execSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    execSpy = spyOn(execMod, "exec");
  });

  afterEach(() => {
    execSpy.mockRestore();
  });

  test("returns Ok when exec succeeds", async () => {
    execSpy.mockReturnValueOnce(
      okAsync({ exitCode: 0, stdout: "", stderr: "" }),
    );

    const result = await cleanupChroot(chrootBaseDir, vmId);
    expect(result.isOk()).toBe(true);
  });

  test("returns Ok even when exec fails (soft-fail via orElse)", async () => {
    const error: LobsterError = {
      code: "EXEC_FAILED",
      message: "rm failed",
    };
    execSpy.mockReturnValueOnce(errAsync(error));

    const result = await cleanupChroot(chrootBaseDir, vmId);
    expect(result.isOk()).toBe(true);
  });
});
