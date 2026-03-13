import { afterEach, describe, expect, mock, test } from "bun:test";
import { okAsync, type ResultAsync } from "neverthrow";
import type { ExecResult, LobsterError } from "../types/index.js";

const execMock = mock();
const execUncheckedMock = mock();

mock.module("./exec.js", () => ({
  exec: (...args: unknown[]) => execMock(...args),
  execUnchecked: (...args: unknown[]) => execUncheckedMock(...args),
}));

const {
  createTap,
  deleteTap,
  addNat,
  removeNat,
  ensureChains,
  addIsolationRules,
  removeIsolationRules,
  addAgentLockdownRules,
  removeAgentLockdownRules,
  flushAndRemoveChains,
  enableIpForwarding,
} = await import("./network.js");

function okExec(): ResultAsync<ExecResult, LobsterError> {
  return okAsync({ exitCode: 0, stdout: "", stderr: "" });
}

afterEach(() => {
  execMock.mockReset();
  execUncheckedMock.mockReset();
});

function allOk(n: number) {
  for (let i = 0; i < n; i++) {
    execMock.mockReturnValueOnce(okExec());
  }
}

function allOkUnchecked(n: number) {
  for (let i = 0; i < n; i++) {
    execUncheckedMock.mockReturnValueOnce(okExec());
  }
}

// ── createTap ────────────────────────────────────────────────────────────────

describe("createTap", () => {
  test("runs ip tuntap add, ip addr add, ip link set, sysctl", async () => {
    allOk(4);
    const result = await createTap("tap0", "10.0.0.1", "10.0.0.2");
    expect(result.isOk()).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(4);

    expect(execMock.mock.calls[0][0]).toEqual([
      "ip",
      "tuntap",
      "add",
      "dev",
      "tap0",
      "mode",
      "tap",
    ]);
    expect(execMock.mock.calls[1][0]).toEqual([
      "ip",
      "addr",
      "add",
      "10.0.0.1/30",
      "dev",
      "tap0",
    ]);
    expect(execMock.mock.calls[2][0]).toEqual([
      "ip",
      "link",
      "set",
      "tap0",
      "up",
    ]);
    expect(execMock.mock.calls[3][0]).toEqual([
      "sysctl",
      "-w",
      "net.ipv6.conf.tap0.disable_ipv6=1",
    ]);
  });
});

// ── deleteTap ────────────────────────────────────────────────────────────────

describe("deleteTap", () => {
  test("runs ip link delete", async () => {
    allOk(1);
    const result = await deleteTap("tap0");
    expect(result.isOk()).toBe(true);
    expect(execMock.mock.calls[0][0]).toEqual(["ip", "link", "delete", "tap0"]);
  });
});

// ── addNat ───────────────────────────────────────────────────────────────────

describe("addNat", () => {
  test("runs 3 iptables -A nat rules", async () => {
    allOk(3);
    const result = await addNat("tap0", "10.0.0.2", 9000);
    expect(result.isOk()).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(3);

    // PREROUTING DNAT
    expect(execMock.mock.calls[0][0]).toEqual([
      "iptables",
      "-t",
      "nat",
      "-A",
      "PREROUTING",
      "-p",
      "tcp",
      "--dport",
      "9000",
      "!",
      "-s",
      "10.0.0.0/8",
      "-j",
      "DNAT",
      "--to-destination",
      "10.0.0.2:9000",
      "-m",
      "comment",
      "--comment",
      "lobster:tap0",
    ]);

    // POSTROUTING MASQUERADE for tap
    expect(execMock.mock.calls[1][0]).toEqual([
      "iptables",
      "-t",
      "nat",
      "-A",
      "POSTROUTING",
      "-o",
      "tap0",
      "-j",
      "MASQUERADE",
      "-m",
      "comment",
      "--comment",
      "lobster:tap0",
    ]);

    // POSTROUTING MASQUERADE outbound
    expect(execMock.mock.calls[2][0]).toEqual([
      "iptables",
      "-t",
      "nat",
      "-A",
      "POSTROUTING",
      "-s",
      "10.0.0.2/32",
      "!",
      "-o",
      "tap0",
      "-j",
      "MASQUERADE",
      "-m",
      "comment",
      "--comment",
      "lobster:tap0:outbound",
    ]);
  });
});

// ── removeNat ────────────────────────────────────────────────────────────────

describe("removeNat", () => {
  test("runs 3 iptables -D nat rules", async () => {
    allOk(3);
    const result = await removeNat("tap0", "10.0.0.2", 9000);
    expect(result.isOk()).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(3);

    expect(execMock.mock.calls[0][0][3]).toBe("-D");
    expect(execMock.mock.calls[0][0][4]).toBe("PREROUTING");
    expect(execMock.mock.calls[1][0][3]).toBe("-D");
    expect(execMock.mock.calls[1][0][4]).toBe("POSTROUTING");
    expect(execMock.mock.calls[2][0][3]).toBe("-D");
  });
});

// ── ensureChains ─────────────────────────────────────────────────────────────

describe("ensureChains", () => {
  test("creates 3 chains, checks 3 jumps, inserts if missing", async () => {
    // 3 chain creates (unchecked)
    allOkUnchecked(3);
    // 3 jump checks (unchecked) — exit 1 means missing
    execUncheckedMock.mockReturnValueOnce(
      okAsync({ exitCode: 1, stdout: "", stderr: "" }),
    );
    // Insert INPUT jump
    execMock.mockReturnValueOnce(okExec());
    execUncheckedMock.mockReturnValueOnce(
      okAsync({ exitCode: 1, stdout: "", stderr: "" }),
    );
    // Insert FORWARD jump
    execMock.mockReturnValueOnce(okExec());
    execUncheckedMock.mockReturnValueOnce(
      okAsync({ exitCode: 1, stdout: "", stderr: "" }),
    );
    // Insert OUTPUT jump
    execMock.mockReturnValueOnce(okExec());

    const result = await ensureChains();
    expect(result.isOk()).toBe(true);

    // Chain creates
    expect(execUncheckedMock.mock.calls[0][0]).toEqual([
      "iptables",
      "-N",
      "LOBSTER-INPUT",
    ]);
    expect(execUncheckedMock.mock.calls[1][0]).toEqual([
      "iptables",
      "-N",
      "LOBSTER-FORWARD",
    ]);
    expect(execUncheckedMock.mock.calls[2][0]).toEqual([
      "iptables",
      "-N",
      "LOBSTER-OUTPUT",
    ]);

    // Jump inserts
    expect(execMock.mock.calls[0][0]).toEqual([
      "iptables",
      "-I",
      "INPUT",
      "1",
      "-j",
      "LOBSTER-INPUT",
    ]);
    expect(execMock.mock.calls[1][0]).toEqual([
      "iptables",
      "-I",
      "FORWARD",
      "1",
      "-j",
      "LOBSTER-FORWARD",
    ]);
    expect(execMock.mock.calls[2][0]).toEqual([
      "iptables",
      "-I",
      "OUTPUT",
      "1",
      "-j",
      "LOBSTER-OUTPUT",
    ]);
  });
});

// ── addIsolationRules ────────────────────────────────────────────────────────

describe("addIsolationRules", () => {
  test("runs 10 iptables -A rules", async () => {
    allOk(10);
    const result = await addIsolationRules("tap0");
    expect(result.isOk()).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(10);

    // First rule: INPUT ESTABLISHED,RELATED
    const r0 = execMock.mock.calls[0][0] as string[];
    expect(r0[1]).toBe("-A");
    expect(r0[2]).toBe("LOBSTER-INPUT");
    expect(r0).toContain("ESTABLISHED,RELATED");
    expect(r0).toContain("lobster:tap0:host-return");

    // Second: INPUT DROP
    const r1 = execMock.mock.calls[1][0] as string[];
    expect(r1[2]).toBe("LOBSTER-INPUT");
    expect(r1).toContain("DROP");
    expect(r1).toContain("lobster:tap0:block-host");

    // Third: FORWARD ESTABLISHED,RELATED return
    const r2 = execMock.mock.calls[2][0] as string[];
    expect(r2[2]).toBe("LOBSTER-FORWARD");
    expect(r2).toContain("lobster:tap0:return");

    // Fourth: FORWARD gateway-in
    const r3 = execMock.mock.calls[3][0] as string[];
    expect(r3).toContain("9000");
    expect(r3).toContain("lobster:tap0:gateway-in");

    // Fifth-Eighth: block-rfc1918 + block-link-local
    expect((execMock.mock.calls[4][0] as string[]).join(" ")).toContain(
      "10.0.0.0/8",
    );
    expect((execMock.mock.calls[5][0] as string[]).join(" ")).toContain(
      "172.16.0.0/12",
    );
    expect((execMock.mock.calls[6][0] as string[]).join(" ")).toContain(
      "192.168.0.0/16",
    );
    expect((execMock.mock.calls[7][0] as string[]).join(" ")).toContain(
      "169.254.0.0/16",
    );

    // Ninth: connlimit
    expect((execMock.mock.calls[8][0] as string[]).join(" ")).toContain(
      "connlimit",
    );
    expect((execMock.mock.calls[8][0] as string[]).join(" ")).toContain("1024");

    // Tenth: outbound ACCEPT
    const r9 = execMock.mock.calls[9][0] as string[];
    expect(r9).toContain("ACCEPT");
    expect(r9).toContain("lobster:tap0:outbound");
  });
});

// ── removeIsolationRules ─────────────────────────────────────────────────────

describe("removeIsolationRules", () => {
  test("runs 10 iptables -D rules", async () => {
    allOk(10);
    const result = await removeIsolationRules("tap0");
    expect(result.isOk()).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(10);

    for (let i = 0; i < 10; i++) {
      expect(execMock.mock.calls[i][0][1]).toBe("-D");
    }
  });
});

// ── addAgentLockdownRules ────────────────────────────────────────────────────

describe("addAgentLockdownRules", () => {
  test("runs 4 OUTPUT rules: accept root + drop for agent and health ports", async () => {
    allOk(4);
    const result = await addAgentLockdownRules("10.0.0.2", 52, 53);
    expect(result.isOk()).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(4);

    // Agent root ACCEPT
    const r0 = execMock.mock.calls[0][0] as string[];
    expect(r0).toContain("LOBSTER-OUTPUT");
    expect(r0).toContain("10.0.0.2");
    expect(r0).toContain("52");
    expect(r0).toContain("ACCEPT");
    expect(r0).toContain("lobster:lockdown:10.0.0.2:agent-root");

    // Health root ACCEPT
    const r1 = execMock.mock.calls[1][0] as string[];
    expect(r1).toContain("53");
    expect(r1).toContain("ACCEPT");

    // Agent DROP
    const r2 = execMock.mock.calls[2][0] as string[];
    expect(r2).toContain("52");
    expect(r2).toContain("DROP");

    // Health DROP
    const r3 = execMock.mock.calls[3][0] as string[];
    expect(r3).toContain("53");
    expect(r3).toContain("DROP");
  });
});

// ── removeAgentLockdownRules ─────────────────────────────────────────────────

describe("removeAgentLockdownRules", () => {
  test("runs 4 iptables -D OUTPUT rules", async () => {
    allOk(4);
    const result = await removeAgentLockdownRules("10.0.0.2", 52, 53);
    expect(result.isOk()).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(4);

    for (let i = 0; i < 4; i++) {
      expect(execMock.mock.calls[i][0][1]).toBe("-D");
      expect(execMock.mock.calls[i][0][2]).toBe("LOBSTER-OUTPUT");
    }
  });
});

// ── flushAndRemoveChains ─────────────────────────────────────────────────────

describe("flushAndRemoveChains", () => {
  test("deletes jumps, flushes chains, removes chains (9 calls)", async () => {
    allOkUnchecked(9);
    const result = await flushAndRemoveChains();
    expect(result.isOk()).toBe(true);
    expect(execUncheckedMock).toHaveBeenCalledTimes(9);

    // Jump deletes
    expect(execUncheckedMock.mock.calls[0][0]).toEqual([
      "iptables",
      "-D",
      "INPUT",
      "-j",
      "LOBSTER-INPUT",
    ]);
    expect(execUncheckedMock.mock.calls[1][0]).toEqual([
      "iptables",
      "-D",
      "FORWARD",
      "-j",
      "LOBSTER-FORWARD",
    ]);
    expect(execUncheckedMock.mock.calls[2][0]).toEqual([
      "iptables",
      "-D",
      "OUTPUT",
      "-j",
      "LOBSTER-OUTPUT",
    ]);

    // Flush
    expect(execUncheckedMock.mock.calls[3][0]).toEqual([
      "iptables",
      "-F",
      "LOBSTER-INPUT",
    ]);
    expect(execUncheckedMock.mock.calls[4][0]).toEqual([
      "iptables",
      "-F",
      "LOBSTER-FORWARD",
    ]);
    expect(execUncheckedMock.mock.calls[5][0]).toEqual([
      "iptables",
      "-F",
      "LOBSTER-OUTPUT",
    ]);

    // Delete chains
    expect(execUncheckedMock.mock.calls[6][0]).toEqual([
      "iptables",
      "-X",
      "LOBSTER-INPUT",
    ]);
    expect(execUncheckedMock.mock.calls[7][0]).toEqual([
      "iptables",
      "-X",
      "LOBSTER-FORWARD",
    ]);
    expect(execUncheckedMock.mock.calls[8][0]).toEqual([
      "iptables",
      "-X",
      "LOBSTER-OUTPUT",
    ]);
  });
});

// ── enableIpForwarding ───────────────────────────────────────────────────────

describe("enableIpForwarding", () => {
  test("runs sysctl -w net.ipv4.ip_forward=1", async () => {
    allOk(1);
    const result = await enableIpForwarding();
    expect(result.isOk()).toBe(true);
    expect(execMock.mock.calls[0][0]).toEqual([
      "sysctl",
      "-w",
      "net.ipv4.ip_forward=1",
    ]);
  });
});
