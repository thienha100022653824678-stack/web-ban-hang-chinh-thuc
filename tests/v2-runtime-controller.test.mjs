// tests/v2-runtime-controller.test.mjs
//
// Unit tests for the V1/V2 runtime master-switch controller + the synchronous
// restrict-only gate. Ported from the LMS test of the same name. node:test,
// no real DB. Uses the controller's test seam
// (`globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__` / `__V2_RUNTIME_STUB_DB__`)
// and the shared in-process cache to exercise v1/v2/kill-switch/cold-cache
// semantics.
//
// IMPORTANT: the controller, the shared cache, and v2-flags are imported
// STATICALLY (no cache-busting query strings) so they all share ONE cache
// instance — exactly like production. Tests reset that shared cache between
// cases via `_resetRuntimeControllerCache()`. The synchronous gate only reads
// the cache, so every case that asserts the gate must first WARM it (via
// warmRuntimeConfig / getActiveMode) so the stub snapshot is loaded.
//
// Key contract under test (restrict-only, fail-open on cold cache):
//   - cold cache            → isV2ActiveCached() === true  (env flags control; V1/tests unchanged)
//   - snapshot v1           → isV2ActiveCached() === false (forces V1; all V2 features OFF)
//   - snapshot v2, kill off → isV2ActiveCached() === true  (permits V2; per-feature flags apply)
//   - snapshot v2, kill on  → isV2ActiveCached() === false (kill switch forces V1)
//   - DB error / missing    → snapshot resolves to v1 (fail-closed for resolution)
//   - env override          → forces mode regardless of DB

import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.VERCEL_ENV = process.env.VERCEL_ENV || "test";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://v2rc-shop-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "v2rc-shop-test-service-role-key";
process.env.INTERNAL_SYNC_SECRET =
  process.env.INTERNAL_SYNC_SECRET || "v2rc-shop-test-internal-sync-secret";

// Shared instances — one cache for the whole process, like production.
const controller = await import("../utils/v2-runtime-controller.js");
const flagsModule = await import("../utils/v2-flags.js");
const cacheModule = await import("../utils/v2-runtime-cache.js");

const ENV_KEYS = ["V2_RUNTIME_FORCE_MODE", "V2_RUNTIME_FORCE_KILL", "V2_RUNTIME_CACHE_TTL_MS"];
const FLAG_ENV_KEYS = [
  "V2_GLOBAL_ONE_DEVICE_ENABLED",
  "V2_CORS_ALLOWLIST_ENABLED",
  "V2_OUTBOX_SHADOW_MODE"
];

function snapshotAllEnv() {
  const s = {};
  for (const k of [...ENV_KEYS, ...FLAG_ENV_KEYS]) s[k] = process.env[k];
  return s;
}
function restoreAllEnv(s) {
  for (const k of [...ENV_KEYS, ...FLAG_ENV_KEYS]) {
    if (s[k] === undefined) delete process.env[k];
    else process.env[k] = s[k];
  }
}
function clearOverrideEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

function reset() {
  controller._resetRuntimeControllerCache();
  delete globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__;
  delete globalThis.__V2_RUNTIME_STUB_DB__;
}

// ── pure helpers ──────────────────────────────────────────────────────────

test("normalizeModeToken: accepts 1/2/v1/v2 (case-insensitive), rejects others", () => {
  const { normalizeModeToken } = controller._internals;
  assert.equal(normalizeModeToken("v1"), "v1");
  assert.equal(normalizeModeToken("V2"), "v2");
  assert.equal(normalizeModeToken("1"), "v1");
  assert.equal(normalizeModeToken("2"), "v2");
  assert.equal(normalizeModeToken(""), null);
  assert.equal(normalizeModeToken("v3"), null);
  assert.equal(normalizeModeToken(undefined), null);
});

test("configRowToValue: accepts bare string and {val}/{value} envelope shapes", () => {
  const { configRowToValue } = controller._internals;
  assert.equal(configRowToValue({ value: "v2" }), "v2");
  assert.equal(configRowToValue({ value: { val: "v1" } }), "v1");
  assert.equal(configRowToValue({ value: { value: "v2" } }), "v2");
  assert.equal(configRowToValue({ value: null }), null);
  assert.equal(configRowToValue(null), null);
  assert.equal(configRowToValue({ value: 123 }), null);
});

// jsonb boolean regression: Supabase returns a JS `true`/`false` (not a
// string) when the column holds a jsonb boolean — e.g. v2_kill_switch
// written via setKillSwitch(true). Before the fix, `typeof v === "boolean"`
// fell through to the object branch → returned null → parseBooleanFlag(null)
// → false → the kill switch silently no-oped. Must round-trip to the bare
// boolean so parseBooleanFlag(true) → true.
test("configRowToValue: jsonb boolean round-trips (v2_kill_switch written as true/false)", () => {
  const { configRowToValue } = controller._internals;
  assert.equal(configRowToValue({ value: true }), true);
  assert.equal(configRowToValue({ value: false }), false);
  assert.equal(configRowToValue({ value: { val: true } }), true);
  assert.equal(configRowToValue({ value: { value: false } }), false);
  assert.equal(configRowToValue({ value: { val: true, value: "v2" } }), true);
});

// ── gate semantics ─────────────────────────────────────────────────────────

test("gate: cold cache → fail-open (true), env flags control behavior", () => {
  const snap = snapshotAllEnv();
  clearOverrideEnv();
  reset();
  try {
    assert.equal(cacheModule.isV2ActiveCached(), true);
    assert.equal(controller.isV2ActiveCached(), true);
  } finally {
    restoreAllEnv(snap);
  }
});

test("gate: snapshot v1 → false (flipping switch to V1 forces all V2 features off)", async () => {
  const snap = snapshotAllEnv();
  clearOverrideEnv();
  reset();
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { activeMode: "v1", killSwitch: false };
  try {
    await controller.warmRuntimeConfig(); // load the stub into the shared cache
    assert.equal(controller.isV2ActiveCached(), false);
  } finally {
    reset();
    restoreAllEnv(snap);
  }
});

test("gate: snapshot v2 + kill off → true (V2 permitted; per-feature flags apply on top)", async () => {
  const snap = snapshotAllEnv();
  clearOverrideEnv();
  reset();
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { activeMode: "v2", killSwitch: false };
  try {
    await controller.warmRuntimeConfig();
    assert.equal(controller.isV2ActiveCached(), true);
  } finally {
    reset();
    restoreAllEnv(snap);
  }
});

test("gate: snapshot v2 + kill on → false (kill switch forces V1 even if mode is v2)", async () => {
  const snap = snapshotAllEnv();
  clearOverrideEnv();
  reset();
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { activeMode: "v2", killSwitch: true };
  try {
    await controller.warmRuntimeConfig();
    assert.equal(controller.isV2ActiveCached(), false);
  } finally {
    reset();
    restoreAllEnv(snap);
  }
});

// ── async resolution ───────────────────────────────────────────────────────

test("getActiveMode: DB stub v2 → resolves v2; getRuntimeSnapshot reports source", async () => {
  const snap = snapshotAllEnv();
  clearOverrideEnv();
  reset();
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { activeMode: "v2", killSwitch: false, source: "stub" };
  try {
    assert.equal(await controller.getActiveMode(), "v2");
    const rs = await controller.getRuntimeSnapshot();
    assert.equal(rs.activeMode, "v2");
    assert.equal(rs.killSwitch, false);
    assert.equal(rs.source, "stub");
    assert.equal(rs.ok, true);
  } finally {
    reset();
    restoreAllEnv(snap);
  }
});

test("getActiveMode: DB stub error → fail-closed to v1, ok=false", async () => {
  const snap = snapshotAllEnv();
  clearOverrideEnv();
  reset();
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { broken: true };
  try {
    assert.equal(await controller.getActiveMode(), "v1");
    const rs = await controller.getRuntimeSnapshot();
    assert.equal(rs.activeMode, "v1");
    assert.equal(rs.ok, false);
    assert.equal(rs.source, "stub_error");
  } finally {
    reset();
    restoreAllEnv(snap);
  }
});

test("isV2Active: snapshot v2 kill off → true; v1 → false", async () => {
  const snap = snapshotAllEnv();
  clearOverrideEnv();
  reset();
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { activeMode: "v2", killSwitch: false };
  try {
    assert.equal(await controller.isV2Active(), true);
  } finally {
    reset();
    restoreAllEnv(snap);
  }
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { activeMode: "v1", killSwitch: false };
  try {
    assert.equal(await controller.isV2Active(), false);
  } finally {
    reset();
    restoreAllEnv(snap);
  }
});

test("warmRuntimeConfig: populates the synchronous gate from the DB stub", async () => {
  const snap = snapshotAllEnv();
  clearOverrideEnv();
  reset();
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { activeMode: "v2", killSwitch: false };
  try {
    const active = await controller.warmRuntimeConfig();
    assert.equal(active, true);
    assert.equal(controller.isV2ActiveCached(), true);
  } finally {
    reset();
    restoreAllEnv(snap);
  }
});

// ── env override escape hatch ──────────────────────────────────────────────

test("env override V2_RUNTIME_FORCE_MODE=v1 forces v1 regardless of DB stub", async () => {
  const snap = snapshotAllEnv();
  clearOverrideEnv();
  process.env.V2_RUNTIME_FORCE_MODE = "v1";
  reset();
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { activeMode: "v2", killSwitch: false };
  try {
    assert.equal(await controller.getActiveMode(), "v1");
    const rs = await controller.getRuntimeSnapshot();
    assert.equal(rs.source, "env_force_mode");
    assert.equal(rs.activeMode, "v1");
    // The override is written into the shared cache, so the sync gate agrees.
    assert.equal(controller.isV2ActiveCached(), false);
  } finally {
    reset();
    restoreAllEnv(snap);
  }
});

test("env override V2_RUNTIME_FORCE_MODE=v2 forces v2 even when DB stub says v1", async () => {
  const snap = snapshotAllEnv();
  clearOverrideEnv();
  process.env.V2_RUNTIME_FORCE_MODE = "v2";
  reset();
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { activeMode: "v1", killSwitch: false };
  try {
    assert.equal(await controller.getActiveMode(), "v2");
    await controller.warmRuntimeConfig();
    assert.equal(controller.isV2ActiveCached(), true);
  } finally {
    reset();
    restoreAllEnv(snap);
  }
});

test("env override V2_RUNTIME_FORCE_KILL=1 forces v1 + kill, overrides a v2 DB stub", async () => {
  const snap = snapshotAllEnv();
  clearOverrideEnv();
  process.env.V2_RUNTIME_FORCE_KILL = "1";
  reset();
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { activeMode: "v2", killSwitch: false };
  try {
    assert.equal(await controller.getActiveMode(), "v1");
    const rs = await controller.getRuntimeSnapshot();
    assert.equal(rs.killSwitch, true);
    assert.equal(rs.source, "env_force_kill");
    assert.equal(controller.isV2ActiveCached(), false);
  } finally {
    reset();
    restoreAllEnv(snap);
  }
});

// ── v2-flags behavioral readers respect the gate ───────────────────────────

test("v2-flags: v1 mode forces one-device + CORS OFF even when env flags are set", async () => {
  // The core owner guarantee: flipping the switch to V1 withdraws V2
  // behavior even when the env flags are still set.
  const snap = snapshotAllEnv();
  clearOverrideEnv();
  process.env.V2_GLOBAL_ONE_DEVICE_ENABLED = "1";
  process.env.V2_CORS_ALLOWLIST_ENABLED = "1";
  reset();
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { activeMode: "v1", killSwitch: false };
  try {
    await controller.warmRuntimeConfig(); // shared cache ← v1
    assert.equal(flagsModule.isV2GlobalOneDeviceEnabled(), false, "v1 mode must force one-device OFF");
    assert.equal(flagsModule.isV2CorsAllowlistEnabled(), false, "v1 mode must force CORS allowlist OFF");
    assert.equal(flagsModule.isV2FlagEnabled("V2_OUTBOX_SHADOW_MODE"), false, "v1 mode must force outbox shadow OFF");
  } finally {
    reset();
    restoreAllEnv(snap);
  }
});

test("v2-flags: v2 mode + env flags ON → features ON (per-feature flag controls)", async () => {
  const snap = snapshotAllEnv();
  clearOverrideEnv();
  process.env.V2_GLOBAL_ONE_DEVICE_ENABLED = "1";
  process.env.V2_CORS_ALLOWLIST_ENABLED = "1";
  reset();
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { activeMode: "v2", killSwitch: false };
  try {
    await controller.warmRuntimeConfig();
    assert.equal(flagsModule.isV2GlobalOneDeviceEnabled(), true);
    assert.equal(flagsModule.isV2CorsAllowlistEnabled(), true);
  } finally {
    reset();
    restoreAllEnv(snap);
  }
});

test("v2-flags: v2 mode but env flag OFF → feature OFF (per-feature flag still applies)", async () => {
  const snap = snapshotAllEnv();
  clearOverrideEnv();
  delete process.env.V2_GLOBAL_ONE_DEVICE_ENABLED;
  reset();
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { activeMode: "v2", killSwitch: false };
  try {
    await controller.warmRuntimeConfig();
    assert.equal(flagsModule.isV2GlobalOneDeviceEnabled(), false);
  } finally {
    reset();
    restoreAllEnv(snap);
  }
});

test("v2-flags: isV2FlagConfigured reports raw env value regardless of runtime mode", async () => {
  // `configured` is the ungated read used by diagnostics to REPORT posture.
  const snap = snapshotAllEnv();
  clearOverrideEnv();
  process.env.V2_OUTBOX_SHADOW_MODE = "true";
  reset();
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { activeMode: "v1", killSwitch: false };
  try {
    await controller.warmRuntimeConfig();
    // In v1 mode: configured=true (env says on), enabled=false (gate forces off).
    assert.equal(flagsModule.isV2FlagConfigured("V2_OUTBOX_SHADOW_MODE"), true);
    assert.equal(flagsModule.isV2FlagEnabled("V2_OUTBOX_SHADOW_MODE"), false);
  } finally {
    reset();
    restoreAllEnv(snap);
  }
});

test("setActiveMode: invalid mode token → { ok:false, code:invalid_mode }, no DB write", async () => {
  const snap = snapshotAllEnv();
  clearOverrideEnv();
  reset();
  try {
    const r1 = await controller.setActiveMode("v3");
    assert.equal(r1.ok, false);
    assert.equal(r1.code, "invalid_mode");
    const r2 = await controller.setActiveMode("");
    assert.equal(r2.ok, false);
    assert.equal(r2.code, "invalid_mode");
  } finally {
    reset();
    restoreAllEnv(snap);
  }
});

// ── setActiveMode upsert recorded into the stub DB ─────────────────────────

test("setActiveMode: valid v2 with stub DB → upsert recorded + cache refreshed", async () => {
  const snap = snapshotAllEnv();
  clearOverrideEnv();
  reset();
  globalThis.__V2_RUNTIME_STUB_DB__ = { v2_active_mode: "v1" };
  try {
    const r = await controller.setActiveMode("v2");
    assert.equal(r.ok, true);
    assert.equal(r.activeMode, "v2");
    // The controller recorded the mode into the stub DB.
    assert.equal(globalThis.__V2_RUNTIME_STUB_DB__.v2_active_mode, "v2");
    // And the shared cache now reflects v2 (refreshRuntimeConfig ran).
    assert.equal(controller.isV2ActiveCached(), true);
  } finally {
    reset();
    restoreAllEnv(snap);
  }
});

test("setKillSwitch: true with stub DB → upsert recorded, gate forces v1", async () => {
  const snap = snapshotAllEnv();
  clearOverrideEnv();
  reset();
  globalThis.__V2_RUNTIME_STUB_DB__ = { v2_active_mode: "v2" };
  try {
    const r = await controller.setKillSwitch(true);
    assert.equal(r.ok, true);
    assert.equal(r.killSwitch, true);
    assert.equal(globalThis.__V2_RUNTIME_STUB_DB__.v2_kill_switch, true);
    // Kill switch on → gate forces v1 even though mode is v2.
    assert.equal(controller.isV2ActiveCached(), false);
  } finally {
    reset();
    restoreAllEnv(snap);
  }
});

// ── V1 preservation (the owner guarantee) ───────────────────────────────────
//
// With no V2_* env flags set and site_config reporting v1 (or no row), every
// existing Shop behavior MUST be unchanged: cold-cache fail-open means
// isV2FlagEnabled defers to the env flag, which is off, so the outbox shadow
// is OFF and V1 is preserved exactly. After a warm with a v1 snapshot, the
// gate forces v1 and the outbox shadow stays OFF.
test("V1 preservation: no V2_* env + v1 snapshot → outbox shadow OFF (V1 unchanged)", async () => {
  const snap = snapshotAllEnv();
  clearOverrideEnv();
  for (const k of FLAG_ENV_KEYS) delete process.env[k];
  reset();
  globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__ = { activeMode: "v1", killSwitch: false };
  try {
    // Before warm: cold cache → fail-open, but env flag is unset → OFF.
    assert.equal(flagsModule.isV2FlagEnabled("V2_OUTBOX_SHADOW_MODE"), false);
    // After warm: v1 snapshot → gate forces v1 → still OFF.
    await controller.warmRuntimeConfig();
    assert.equal(flagsModule.isV2FlagEnabled("V2_OUTBOX_SHADOW_MODE"), false);
    // isV2OutboxShadowMode (in v2-outbox.js) reads isV2FlagEnabled → OFF.
    const outbox = await import("../utils/v2-outbox.js");
    assert.equal(outbox.isV2OutboxShadowMode(), false);
  } finally {
    reset();
    restoreAllEnv(snap);
  }
});

test("V1 preservation: cold cache + no V2_* env → outbox shadow OFF (fail-open still V1)", async () => {
  const snap = snapshotAllEnv();
  clearOverrideEnv();
  for (const k of FLAG_ENV_KEYS) delete process.env[k];
  reset();
  try {
    // Cold cache: gate is fail-open (true), but the env flag is unset so
    // isV2FlagEnabled returns false → outbox shadow OFF. V1 unchanged.
    assert.equal(controller.isV2ActiveCached(), true);
    assert.equal(flagsModule.isV2FlagEnabled("V2_OUTBOX_SHADOW_MODE"), false);
    const outbox = await import("../utils/v2-outbox.js");
    assert.equal(outbox.isV2OutboxShadowMode(), false);
  } finally {
    reset();
    restoreAllEnv(snap);
  }
});
