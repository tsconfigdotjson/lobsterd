# Unit Testing Plan for lobsterd

## Context

lobsterd is an ~8,000-line TypeScript codebase (53 files) with **zero tests**. The goal is to add comprehensive unit test coverage in phases, ordered by value-to-effort ratio, each completable in a single Claude Code session. We use Bun's built-in test runner (`bun test`), co-located test files (`*.test.ts`), and `bun:test` mocking.

---

## Phase 0: Infrastructure Setup

**Goal:** Test runner config, CI integration, shared test utilities.

**Changes:**
- `package.json`: add `"test": "bun test"`, `"test:coverage": "bun test --coverage"`, append `&& bun test` to `"ci"`
- Create `src/test-helpers.ts`:
  - `makeTenant(overrides?)` — valid Tenant fixture with sensible defaults
  - `makeConfig(overrides?)` — DEFAULT_CONFIG with deep merge
  - `makeRegistry(tenants?, overrides?)` — EMPTY_REGISTRY with tenants
  - `unwrapOk(resultAsync)` — await + assert Ok + return value
  - `unwrapErr(resultAsync)` — await + assert Err + return error
- Create `src/test-helpers.test.ts` — verify factories produce valid objects

**Prompt:**
> Add unit testing infrastructure to lobsterd. There are currently zero tests.
>
> 1. Add `"test": "bun test"` and `"test:coverage": "bun test --coverage"` to package.json scripts. Update `"ci"` to append `&& bun test`.
>
> 2. Create `src/test-helpers.ts` with: `makeTenant(overrides?: Partial<Tenant>)` returning a valid Tenant (name "test-tenant", vmId "vm-test-tenant", cid 3, ipAddress "10.0.0.2", hostIp "10.0.0.1", tapDev "tap-test-tenant", gatewayPort 9000, overlayPath, socketPath, vmPid 12345, createdAt ISO string, status "active", gatewayToken, jailUid 10000, agentToken, suspendInfo null). `makeConfig(overrides?)` spreading DEFAULT_CONFIG. `makeRegistry(tenants?, overrides?)` spreading EMPTY_REGISTRY. `unwrapOk<T,E>(ResultAsync<T,E>)` and `unwrapErr<T,E>(ResultAsync<T,E>)`.
>
> 3. Create `src/test-helpers.test.ts` verifying factories and unwrap helpers.
>
> All code must pass `bun run ci`. Double quotes, semicolons, no `any`, braces on blocks.

**Coverage after:** ~0%

---

## Phase 1: Pure Logic — Schemas, State Machine, Error Mapping, Events

**Goal:** Test all zero-dependency pure functions. Maximum value per line of test.

**Files to test:**

| Source | Test file | Key assertions |
|---|---|---|
| `src/config/schema.ts` | `schema.test.ts` | 14 Zod schemas, TENANT_NAME_REGEX (valid: "my-tenant", "a"; invalid: uppercase, leading-dash, digits, empty, spaces) |
| `src/config/defaults.ts` | `defaults.test.ts` | DEFAULT_CONFIG passes schema, EMPTY_REGISTRY passes schema, port/uid alignment |
| `src/watchdog/state.ts` | `state.test.ts` | All state transitions: UNKNOWN->HEALTHY, UNKNOWN->DEGRADED, HEALTHY->DEGRADED, DEGRADED->RECOVERING, DEGRADED->FAILED (max repairs), RECOVERING->HEALTHY, FAILED stays stuck, SUSPENDED->HEALTHY |
| `src/reef/errors.ts` | `errors.test.ts` | errorToStatus() for every ErrorCode, stripSecrets() removes cause |
| `src/watchdog/events.ts` | `events.test.ts` | on/emit, multiple listeners, unsubscribe, removeAllListeners |

**Mocking:** None needed.

**Prompt:**
> Add unit tests for pure logic modules in lobsterd. Use `bun:test` with describe/test/expect. Import helpers from `src/test-helpers.ts`. Co-locate tests.
>
> 1. `src/config/schema.test.ts` — Test TENANT_NAME_REGEX accepts "my-tenant", "a", "tenant_1"; rejects uppercase, leading-dash, leading-digit, empty, spaces, dots. Test lobsterdConfigSchema parses DEFAULT_CONFIG, rejects missing firecracker, rejects vcpu 0, rejects mem 64. Test tenantSchema with makeTenant(), rejects cid<3, invalid IP, bad status, bad name. Test tenantRegistrySchema, rejects nextCid 2. Test buoyConfigSchema, suspendInfoSchema.
>
> 2. `src/config/defaults.test.ts` — DEFAULT_CONFIG passes lobsterdConfigSchema. EMPTY_REGISTRY passes tenantRegistrySchema. nextGatewayPort equals gatewayPortStart. nextJailUid equals uidStart. Path constants start with "/".
>
> 3. `src/watchdog/state.test.ts` — Test initialWatchState() shape. Test transition(): UNKNOWN+all-ok->HEALTHY, UNKNOWN+fail->DEGRADED, HEALTHY+ok->HEALTHY, HEALTHY+fail->DEGRADED, DEGRADED+ok->RECOVERING, DEGRADED+fail+attempts<max->DEGRADED, DEGRADED+fail+attempts>=max->FAILED, RECOVERING+ok->HEALTHY, RECOVERING+fail->DEGRADED, FAILED+ok->HEALTHY, FAILED+fail->FAILED(no repair), SUSPENDED+ok->HEALTHY. Test resetToMolting() resets state/attempts.
>
> 4. `src/reef/errors.test.ts` — errorToStatus for TENANT_NOT_FOUND->404, TENANT_EXISTS->409, VSOCK_CONNECT_FAILED->502, EXEC_TIMEOUT->504, VALIDATION_FAILED->422, LOCK_FAILED->503, NOT_ROOT->403. EXEC_FAILED->500. stripSecrets strips cause.
>
> 5. `src/watchdog/events.test.ts` — on+emit calls listener. Multiple listeners. Unsubscribe. removeAllListeners. Emit with no listeners safe.
>
> All tests must pass `bun run ci`.

**Coverage after:** ~12%

---

## Phase 2: Pure Functions in System/Command Layer

**Goal:** Test pure functions embedded in modules that also have I/O.

**Files to test:**

| Source | Test file | Key assertions |
|---|---|---|
| `src/system/jailer.ts` | `jailer.test.ts` | getChrootRoot(), getApiSocketPath(), buildJailerArgs() |
| `src/system/systemd.ts` | `systemd.test.ts` | generateWatchUnit() string output |
| `src/system/ssh.ts` | `ssh.test.ts` | getPrivateKeyPath() |
| `src/commands/spawn.ts` | `spawn.test.ts` | computeSubnetIps() (export it first) |
| `src/commands/tank-data.ts` | `tank-data.test.ts` | Data formatting, quickPidCheck with mocked process.kill |
| `src/reef/schemas.ts` | `schemas.test.ts` | OpenAPI Zod schemas |

**Action required:** Export `computeSubnetIps` from `src/commands/spawn.ts`.

**Prompt:**
> Add unit tests for pure functions in system and command modules. Co-locate tests.
>
> 1. `src/system/jailer.test.ts` — getChrootRoot returns correct path. getApiSocketPath appends /api.socket. buildJailerArgs without cgroups has --id, --exec-file, --uid, --gid, --, --api-sock. With cgroups includes --cgroup.
>
> 2. `src/system/systemd.test.ts` — generateWatchUnit() has ExecStart with bun path, [Unit]/[Service]/[Install] sections, SyslogIdentifier, Restart=on-failure.
>
> 3. `src/system/ssh.test.ts` — getPrivateKeyPath("my-tenant") returns "/var/lib/lobsterd/ssh/my-tenant/id_ed25519".
>
> 4. First export computeSubnetIps from spawn.ts. Then `src/commands/spawn.test.ts`: index 0 -> hostIp "10.0.0.1"/guestIp "10.0.0.2". Index 1 -> "10.0.0.5"/"10.0.0.6". Index 63 correct. Base "172.16.0.0" works.
>
> 5. `src/commands/tank-data.test.ts` — quickPidCheck: null vmPid->"dead", process.kill succeeds->pid string, kill throws->"dead". Use spyOn(process,"kill").
>
> 6. `src/reef/schemas.test.ts` — TenantNameParam, SpawnRequestBody, HealthResponse, TenantResponse with valid/invalid inputs.
>
> All tests must pass `bun run ci`.

**Coverage after:** ~20%

---

## Phase 3: Reef Auth & Health Route

**Goal:** Test bearer auth middleware and health endpoint using Hono's test client.

| Source | Test file |
|---|---|
| `src/reef/auth.ts` | `auth.test.ts` |
| `src/reef/routes/health.ts` | `health.test.ts` |

**Key tests:**
- Auth: no header->401, wrong token->401, correct token->200, wrong scheme->401, /health bypasses auth, /openapi.json bypasses auth
- Health: returns `{ status, uptime, tenantCount }`. Mock loadRegistry for tenant count.

**Mocking:** Hono `app.request()` for HTTP, `mock.module` for loadRegistry.

**Prompt:**
> Add tests for reef auth middleware and health route.
>
> 1. `src/reef/auth.test.ts` — Create test Hono app with bearerAuth("test-token") + GET /test route. No Authorization->401. "Bearer wrong"->401. "Bearer test-token"->200. "Basic test-token"->401. /health without token->bypasses. /openapi.json->bypasses. Use app.request().
>
> 2. `src/reef/routes/health.test.ts` — Mock loadRegistry via mock.module. When ok with 2 tenants: GET /health returns status "ok", tenantCount 2, numeric uptime. When err: tenantCount 0.
>
> All tests must pass `bun run ci`.

**Coverage after:** ~25%

---

## Phase 4: System Wrappers — exec, image, firecracker, caddy

**Goal:** Test all system I/O wrappers by mocking Bun.spawn and fetch.

| Source | Test file | Mock strategy |
|---|---|---|
| `src/system/exec.ts` | `exec.test.ts` | spyOn(Bun, "spawn") with mockProcess helper |
| `src/system/image.ts` | `image.test.ts` | mock.module("./exec.js") |
| `src/system/firecracker.ts` | `firecracker.test.ts` | spyOn(globalThis, "fetch") |
| `src/system/caddy.ts` | `caddy.test.ts` | spyOn(globalThis, "fetch") |

**Key tests:**
- exec: exitCode 0->Ok, exitCode 1->Err(EXEC_FAILED), execUnchecked 1->Ok, asUser wraps sudo, getUid parses stdout
- image: createOverlay chains truncate+mkfs, deleteOverlay rm -f, resizeOverlay truncate+e2fsck+resize2fs
- firecracker: all 11 FC API functions verify correct HTTP method/path/body/unix option, non-ok->Err
- caddy: addRoute 2 POSTs, removeRoute 2 DELETEs, listRoutes GET, writeCaddyBaseConfig with/without TLS

**Prompt:**
> Add tests for system wrappers. Mock I/O dependencies.
>
> 1. `src/system/exec.test.ts` — Mock Bun.spawn with helper returning {pid,exited,stdout,stderr,kill,unref}. exec ok/fail, execUnchecked ignores exit code, asUser wraps sudo, getUid parses.
>
> 2. `src/system/image.test.ts` — Mock exec from "./exec.js". createOverlay 2 calls, deleteOverlay 1 call, resizeOverlay 3 calls. Error propagation.
>
> 3. `src/system/firecracker.test.ts` — Mock fetch. configureVm PUT /machine-config. setBootSource, addDrive (with/without rate limiter), addNetworkInterface, startInstance, pauseVm, resumeVm, createSnapshot, loadSnapshot. All verify unix socket option. Non-ok->Err.
>
> 4. `src/system/caddy.test.ts` — Mock fetch. addRoute 2 POSTs (ws+http). removeRoute 2 DELETEs. listRoutes GET. writeCaddyBaseConfig with/without TLS. Fetch failure->CADDY_API_ERROR.
>
> All tests must pass `bun run ci`.

**Coverage after:** ~40%

---

## Phase 5: Health Checks & Repair Logic

**Goal:** Test check/repair modules with mocked system dependencies.

| Source | Test file |
|---|---|
| `src/checks/vm.ts` | `vm.test.ts` |
| `src/checks/network.ts` | `network.test.ts` |
| `src/checks/index.ts` | `index.test.ts` |
| `src/repair/index.ts` | `index.test.ts` |
| `src/repair/network.ts` | `network.test.ts` |

**Key tests:**
- VM checks: null pid->failed, kill succeeds->ok, kill throws->failed, healthPing true/false/err
- Network checks: TAP exists/missing, gateway with suspended skip, Caddy route present/missing
- Repair dispatch: REPAIR_MAP routing, deduplication, error suppression
- Network repair: repairTap chains createTap+addNat+addIsolation, repairCaddyRoute remove+add

**Mocking:** mock.module for vsock, exec, caddy, network. All return okAsync/errAsync.

**Prompt:**
> Add tests for health checks and repair modules. Mock system deps with mock.module.
>
> 1. `src/checks/vm.test.ts` — checkVmProcess: null pid->failed, kill ok->ok, kill throws->failed. checkVmResponsive: healthPing ok(true)->ok, ok(false)->failed, err->failed.
>
> 2. `src/checks/network.test.ts` — checkTapDevice: exec ok->ok, fail->failed. checkGatewayPort: suspended->skip, getStats gatewayPid>0->ok, null->failed. checkCaddyRoute: routes with matching IDs->ok, missing->failed.
>
> 3. `src/checks/index.test.ts` — runAllChecks combines VM+network. runQuickChecks VM only.
>
> 4. `src/repair/index.test.ts` — Dispatch to correct repair fn. Deduplication. Empty checks->empty results. Failed repair->fixed:false.
>
> 5. `src/repair/network.test.ts` — repairTap success->fixed:true, failure->fixed:false. repairCaddyRoute remove+add->fixed:true.
>
> Use makeTenant/makeConfig. All mocks return okAsync/errAsync. All tests pass `bun run ci`.

**Coverage after:** ~55%

---

## Phase 6: Config Loader & Network Module

**Goal:** Test config I/O (with mocked filesystem) and network module argument construction.

| Source | Test file |
|---|---|
| `src/config/loader.ts` | `loader.test.ts` |
| `src/system/network.ts` | `network.test.ts` |
| `src/system/systemd.ts` | `systemd.test.ts` (extend) |

**Key tests:**
- Loader: file missing->defaults, valid JSON->parsed, invalid->CONFIG_INVALID, atomic write, lock acquire/release
- Network: verify exact iptables command arrays for all 11 functions (createTap, deleteTap, addNat, removeNat, ensureChains, addIsolationRules, removeIsolationRules, addAgentLockdownRules, removeAgentLockdownRules, flushAndRemoveChains, enableIpForwarding)
- Systemd: installService writes+daemon-reload, enableAndStart, stopAndRemove

**Mocking:** Bun.file/Bun.write/node:fs for loader; mock.module("./exec.js") for network/systemd.

**Coverage after:** ~70%

---

## Phase 7: Command Integration Tests (spawn, evict, molt)

**Goal:** Test orchestration logic, error paths, and rollback with all deps mocked.

| Source | Test file |
|---|---|
| `src/commands/spawn.ts` | `spawn.test.ts` (extend) |
| `src/commands/evict.ts` | `evict.test.ts` |
| `src/commands/molt.ts` | `molt.test.ts` |

**Key tests:**
- Spawn: invalid name->VALIDATION_FAILED, duplicate->TENANT_EXISTS, happy path returns Tenant, rollback on createTap failure
- Evict: not found->TENANT_NOT_FOUND, full cleanup sequence, suspended tenant snapshot cleanup
- Molt: not found error, all-healthy fast path, repair+recheck flow

**Mocking:** mock.module for ALL system/config imports. Every mock returns okAsync.

**Coverage after:** ~75%

---

## What's Intentionally Excluded

- **UI components** (`src/ui/*.tsx`): Need ink-testing-library, low value/effort ratio
- **Watchdog loop/scheduler** (`src/watchdog/loop.ts`, `scheduler.ts`): Complex async with timers; individual components tested instead
- **CLI entry point** (`src/index.tsx`): Commander wiring, tested implicitly
- **Interactive init** (`src/commands/init.ts`): Ink TUI + file downloads

These could be a future Phase 8+ once the core is covered.

---

## Coverage Progression

```
Phase 0: ~0%   ████░░░░░░░░░░░░░░░░  Infrastructure
Phase 1: ~12%  ██████░░░░░░░░░░░░░░  Pure logic
Phase 2: ~20%  ████████░░░░░░░░░░░░  Pure functions in mixed modules
Phase 3: ~25%  █████████░░░░░░░░░░░  Auth + health route
Phase 4: ~40%  ████████████░░░░░░░░  System wrappers
Phase 5: ~55%  ███████████████░░░░░  Checks + repairs
Phase 6: ~70%  ██████████████████░░  Config I/O + network
Phase 7: ~75%  ███████████████████░  Command integration
```

## Bun-Specific Notes

- Module mocking: `mock.module("./path.js", () => ({ fn: mock(() => ...) }))` — path must match source import
- neverthrow: every function returns ResultAsync — use `unwrapOk`/`unwrapErr` helpers
- Bun.spawn mock needs: `{ pid, exited: Promise, stdout: ReadableStream, stderr: ReadableStream, kill, unref }`
- fetch unix option: `fetch(url, { unix: socketPath })` — verify in firecracker/caddy tests
- Biome: double quotes, semicolons, no `any`, braces on blocks
