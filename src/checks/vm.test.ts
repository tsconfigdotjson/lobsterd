import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import * as vsock from "../system/vsock.js";
import { makeTenant } from "../test-helpers.js";
import type { LobsterError } from "../types/index.js";
import { checkVmProcess, checkVmResponsive } from "./vm.js";

let healthPingSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  healthPingSpy = spyOn(vsock, "healthPing");
});

afterEach(() => {
  healthPingSpy.mockRestore();
});

describe("checkVmProcess", () => {
  test("returns failed when vmPid is null", async () => {
    const tenant = makeTenant({ vmPid: null });
    const r = (await checkVmProcess(tenant))._unsafeUnwrap();
    expect(r.check).toBe("vm.process");
    expect(r.status).toBe("failed");
    expect(r.message).toBe("No VM PID recorded");
  });

  test("returns ok when process.kill succeeds", async () => {
    const killSpy = spyOn(process, "kill").mockImplementation(() => true);
    const tenant = makeTenant({ vmPid: 999 });
    const r = (await checkVmProcess(tenant))._unsafeUnwrap();
    expect(r.check).toBe("vm.process");
    expect(r.status).toBe("ok");
    expect(r.message).toContain("999");
    killSpy.mockRestore();
  });

  test("returns failed when process.kill throws", async () => {
    const killSpy = spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const tenant = makeTenant({ vmPid: 999 });
    const r = (await checkVmProcess(tenant))._unsafeUnwrap();
    expect(r.check).toBe("vm.process");
    expect(r.status).toBe("failed");
    expect(r.message).toContain("999");
    expect(r.message).toContain("dead");
    killSpy.mockRestore();
  });
});

describe("checkVmResponsive", () => {
  test("returns ok when healthPing returns true", async () => {
    healthPingSpy.mockReturnValue(okAsync(true) as never);
    const tenant = makeTenant();
    const r = (await checkVmResponsive(tenant, 52))._unsafeUnwrap();
    expect(r.check).toBe("vm.responsive");
    expect(r.status).toBe("ok");
    expect(r.message).toContain("responded");
  });

  test("returns failed when healthPing returns false", async () => {
    healthPingSpy.mockReturnValue(okAsync(false) as never);
    const tenant = makeTenant();
    const r = (await checkVmResponsive(tenant, 52))._unsafeUnwrap();
    expect(r.check).toBe("vm.responsive");
    expect(r.status).toBe("failed");
    expect(r.message).toContain("did not respond");
  });

  test("returns failed when healthPing returns err", async () => {
    healthPingSpy.mockReturnValue(
      errAsync<boolean, LobsterError>({
        code: "VSOCK_CONNECT_FAILED",
        message: "timeout",
      }) as never,
    );
    const tenant = makeTenant();
    const r = (await checkVmResponsive(tenant, 52))._unsafeUnwrap();
    expect(r.check).toBe("vm.responsive");
    expect(r.status).toBe("failed");
    expect(r.message).toContain("Could not reach");
  });
});
