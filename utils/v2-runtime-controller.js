// utils/v2-runtime-controller.js
//
// Runtime active-mode controller for the V1/V2 coexistence platform.
// Ported from the LMS repo (utils/v2-runtime-controller.js) verbatim in
// behavior; Shop-specific note: this reads DB B `site_config` via the
// EXISTING `import { supabase } from "./supabase.js"` (service-role client).
//
// Single source of truth for whether the platform is serving V1 or V2
// behavior. The mode is persisted in Supabase B `site_config`
// (keys `v2_active_mode` + `v2_kill_switch`) so the owner can flip it from
// the admin UI without a redeploy and without touching V1 code.
//
// Restrict-only master gate (fail-open on cold cache):
//   - The synchronous gate `isV2ActiveCached()` lives in v2-runtime-cache.js
//     and is what the behavioral flag readers actually check. It returns
//     TRUE when the cache is cold (no snapshot yet) so that V1 and the
//     existing tests behave exactly as before this controller existed.
//   - It returns FALSE only when a resolved snapshot says activeMode='v1'
//     (or the kill switch is on) — i.e. the owner has explicitly flipped
//     the switch to V1, which forces every V2 behavioral feature OFF.
//   - It returns TRUE when the snapshot says activeMode='v2' and the kill
//     switch is off — the switch permits V2; per-feature env flags control.
//
// Fail-closed for mode RESOLUTION: when the DB is unreadable or the config
//   row is missing, the snapshot is set to activeMode='v1' (safe state). The
//   gate therefore forces V1 when the DB is down. Cold-cache fail-open only
//   applies BEFORE the first snapshot is loaded in an instance.
//
// Env override escape hatch: V2_RUNTIME_FORCE_MODE=1|2|v1|v2 and
//   V2_RUNTIME_FORCE_KILL=1. Lets an operator force a mode without DB
//   access (e.g. a preview deploy with no config row). Not used by the UI.
//
// Caching: the routers await warmRuntimeConfig() once per request; the
//   behavioral readers then use the synchronous gate. The admin flip
//   endpoint calls refreshRuntimeConfig() so the new mode is visible on
//   that instance immediately; other instances pick it up within the TTL.

import { supabase } from "./supabase.js";
import { parseBooleanFlag } from "./v2-flags.js";
import {
  getCachedSnapshot,
  setCachedSnapshot,
  clearCachedSnapshot,
  isV2ActiveCached
} from "./v2-runtime-cache.js";

export { isV2ActiveCached };

export const ACTIVE_MODES = Object.freeze({
  V1: "v1",
  V2: "v2"
});

const CONFIG_KEY_ACTIVE_MODE = "v2_active_mode";
const CONFIG_KEY_KILL_SWITCH = "v2_kill_switch";

const DEFAULT_CACHE_TTL_MS = 5_000; // 5s

let inflightLoad = null;

function getCacheTtlMs() {
  const raw = Number(process.env.V2_RUNTIME_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CACHE_TTL_MS;
}

function normalizeModeToken(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "1" || raw === "v1") return ACTIVE_MODES.V1;
  if (raw === "2" || raw === "v2") return ACTIVE_MODES.V2;
  return null; // unknown / empty → fail-closed to v1
}

// Resolve the operator escape-hatch env override. Pure; reads process.env.
function resolveEnvOverride() {
  const forceKill = parseBooleanFlag(process.env.V2_RUNTIME_FORCE_KILL);
  const forcedMode = normalizeModeToken(process.env.V2_RUNTIME_FORCE_MODE);
  if (forceKill) return { activeMode: ACTIVE_MODES.V1, killSwitch: true, source: "env_force_kill" };
  if (forcedMode) return { activeMode: forcedMode, killSwitch: false, source: "env_force_mode" };
  return null;
}

function configRowToValue(row) {
  if (!row || row.value === undefined || row.value === null) return null;
  const v = row.value;
  // jsonb boolean (e.g. v2_kill_switch written as `true`/`false`). Must be
  // handled BEFORE the object-envelope branch, and returned as-is so
  // parseBooleanFlag(true) → true. Without this, a jsonb `true` fell through
  // to `null` and the kill switch silently no-oped.
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null) {
    // Object envelope {val: ...} / {value: ...}. Defend against a boolean
    // inside the envelope too (e.g. {val: true}) so the kill switch
    // round-trips either way.
    if (typeof v.val === "boolean") return v.val;
    if (typeof v.val === "string") return v.val;
    if (typeof v.value === "boolean") return v.value;
    if (typeof v.value === "string") return v.value;
  }
  return null;
}

// Read both config keys in one round trip. Returns a snapshot; never throws.
// Test seam: when `globalThis.__V2_RUNTIME_STUB_DB__` is set (an object
// mapping config key → value, or the literal false to simulate a DB error),
// the load is satisfied from the stub instead of the real DB. The endpoint
// tests use this so setActiveMode's upsert + refresh can run end-to-end
// against the in-test supabase shim without network.
async function loadSnapshotFromDb() {
  const stubDb = globalThis.__V2_RUNTIME_STUB_DB__;
  if (stubDb !== undefined) {
    if (stubDb === false || stubDb === "error") {
      return { activeMode: ACTIVE_MODES.V1, killSwitch: false, source: "db_error", ok: false };
    }
    if (stubDb && typeof stubDb === "object") {
      const mode = normalizeModeToken(stubDb[CONFIG_KEY_ACTIVE_MODE]);
      const kill = parseBooleanFlag(stubDb[CONFIG_KEY_KILL_SWITCH]);
      if (kill) return { activeMode: ACTIVE_MODES.V1, killSwitch: true, source: "db_kill_switch", ok: true };
      if (mode) return { activeMode: mode, killSwitch: false, source: "db", ok: true };
      return { activeMode: ACTIVE_MODES.V1, killSwitch: false, source: "db_default", ok: true };
    }
  }
  try {
    const { data, error } = await supabase
      .from("site_config")
      .select("key, value")
      .in("key", [CONFIG_KEY_ACTIVE_MODE, CONFIG_KEY_KILL_SWITCH]);

    if (error) {
      return { activeMode: ACTIVE_MODES.V1, killSwitch: false, source: "db_error", ok: false };
    }

    let activeMode = null;
    let killSwitch = false;
    for (const row of data || []) {
      if (row.key === CONFIG_KEY_ACTIVE_MODE) {
        activeMode = normalizeModeToken(configRowToValue(row));
      } else if (row.key === CONFIG_KEY_KILL_SWITCH) {
        killSwitch = parseBooleanFlag(configRowToValue(row));
      }
    }

    if (killSwitch) {
      return { activeMode: ACTIVE_MODES.V1, killSwitch: true, source: "db_kill_switch", ok: true };
    }
    if (activeMode) {
      return { activeMode, killSwitch: false, source: "db", ok: true };
    }
    // No row / unrecognized value → fail-closed to v1 (but cache it so the
    // gate stops being fail-open-on-cold and actually forces v1).
    return { activeMode: ACTIVE_MODES.V1, killSwitch: false, source: "db_default", ok: true };
  } catch {
    return { activeMode: ACTIVE_MODES.V1, killSwitch: false, source: "db_exception", ok: false };
  }
}

// Test seam: record site_config upserts into `globalThis.__V2_RUNTIME_STUB_DB__`
// so setActiveMode/setKillSwitch in tests mutate the stub DB (and the next
// resolveSnapshot reads the new value back). No-op in production.
function recordUpsertToStubDb(key, value) {
  const stubDb = globalThis.__V2_RUNTIME_STUB_DB__;
  if (stubDb && typeof stubDb === "object") {
    try {
      stubDb[key] = value;
    } catch {
      /* best-effort */
    }
  }
}

// Resolve the effective snapshot. Honors env override, a test stub, and the
// shared cache. Coalesces concurrent loads into one DB round trip. Every
// resolved snapshot (override / stub / db) is written into the shared
// synchronous cache so a subsequent `isV2ActiveCached()` read reflects it;
// cold-cache fail-open only applies BEFORE the first warm in an instance.
async function resolveSnapshot({ forceRefresh = false } = {}) {
  const override = resolveEnvOverride();
  if (override) {
    const snap = { ...override, ok: true };
    setCachedSnapshot(snap, getCacheTtlMs());
    return { ...snap };
  }

  const stub = globalThis.__V2_RUNTIME_CONTROLLER_SNAPSHOT__;
  if (stub !== undefined) {
    const resolved = typeof stub === "function" ? await stub() : stub;
    let snap;
    if (resolved && resolved.activeMode) {
      snap = {
        activeMode: resolved.activeMode,
        killSwitch: Boolean(resolved.killSwitch),
        source: resolved.source || "stub",
        ok: true
      };
    } else {
      snap = { activeMode: ACTIVE_MODES.V1, killSwitch: false, source: "stub_error", ok: false };
    }
    setCachedSnapshot(snap, getCacheTtlMs());
    return { ...snap };
  }

  if (forceRefresh) {
    clearCachedSnapshot();
  }
  // Fast path: the shared synchronous cache already holds a fresh snapshot.
  const cached = getCachedSnapshot();
  if (cached) return { ...cached };

  if (!inflightLoad) {
    inflightLoad = (async () => {
      const snap = await loadSnapshotFromDb();
      setCachedSnapshot(snap, getCacheTtlMs());
      return snap;
    })();
  }
  try {
    return { ...(await inflightLoad) };
  } finally {
    inflightLoad = null;
  }
}

/**
 * The resolved active mode ('v1' | 'v2'). Fail-closed to 'v1' on any DB
 * error / missing config. Async only on the first read in a cold instance;
 * cached afterwards.
 */
export async function getActiveMode() {
  const snap = await resolveSnapshot();
  return snap.activeMode;
}

/**
 * Master gate: is the platform in v2 mode (kill switch off)? For individual
 * behavioral features prefer the synchronous `isV2ActiveCached()` gate from
 * v2-runtime-cache.js (re-exported above) inside hot paths. This async form
 * is for diagnostics / admin display.
 */
export async function isV2Active() {
  const snap = await resolveSnapshot();
  return snap.activeMode === ACTIVE_MODES.V2 && !snap.killSwitch;
}

/**
 * Full snapshot for diagnostics / admin display. Never throws. `source`
 * explains why the mode is what it is:
 *   'db' | 'db_default' | 'db_kill_switch' | 'db_error' | 'db_exception'
 *   | 'env_force_mode' | 'env_force_kill' | 'stub' | 'stub_error' | 'cache'
 */
export async function getRuntimeSnapshot() {
  const snap = await resolveSnapshot();
  return {
    activeMode: snap.activeMode,
    killSwitch: Boolean(snap.killSwitch),
    ok: Boolean(snap.ok),
    source: snap.source
  };
}

/**
 * Warm the in-process cache once at the start of a request so the
 * synchronous gate is populated for the rest of the invocation. Safe to
 * call on every request — concurrent calls coalesce into one DB read.
 * Never throws.
 */
export async function warmRuntimeConfig() {
  try {
    await resolveSnapshot();
  } catch {
    // resolveSnapshot never throws, but guard anyway.
  }
  return isV2ActiveCached();
}

/**
 * Force a cache refresh on this instance. Called by the admin flip endpoint
 * right after it writes the new mode, so the same instance reports the new
 * mode immediately. Also exposed for tests.
 */
export async function refreshRuntimeConfig() {
  await resolveSnapshot({ forceRefresh: true });
  return isV2ActiveCached();
}

/**
 * Persist a new active mode to site_config. Additive upsert on an existing
 * table — no migration. Validates the mode token; rejects anything that is
 * not 'v1' or 'v2'. Returns { ok, activeMode } or { ok:false, code }.
 *
 * Does NOT flip per-feature env flags; those stay where the operator set
 * them. Flipping to v2 only PERMITS the per-feature flags to take effect
 * (see isV2ActiveCached). Flipping to v1 forces all V2 features off.
 */
export async function setActiveMode(mode) {
  const normalized = normalizeModeToken(mode);
  if (!normalized) {
    return { ok: false, code: "invalid_mode" };
  }
  // Test seam: when the in-test stub DB is set, short-circuit the real
  // supabase upsert and record into the stub so a subsequent resolve reads
  // the new value back. No-op in production (stub is undefined).
  if (globalThis.__V2_RUNTIME_STUB_DB__ !== undefined) {
    recordUpsertToStubDb(CONFIG_KEY_ACTIVE_MODE, normalized);
    await refreshRuntimeConfig();
    return { ok: true, activeMode: normalized };
  }
  try {
    const { error } = await supabase
      .from("site_config")
      .upsert(
        { key: CONFIG_KEY_ACTIVE_MODE, value: normalized },
        { onConflict: "key" }
      );
    if (error) {
      return { ok: false, code: "db_error" };
    }
  } catch {
    return { ok: false, code: "db_exception" };
  }
  await refreshRuntimeConfig();
  return { ok: true, activeMode: normalized };
}

/**
 * Persist the kill-switch flag. When true the controller forces v1. Used
 * for an emergency hard-stop that survives a stuck v2 row. Additive upsert.
 */
export async function setKillSwitch(enabled) {
  const value = parseBooleanFlag(enabled) ? true : false;
  if (globalThis.__V2_RUNTIME_STUB_DB__ !== undefined) {
    recordUpsertToStubDb(CONFIG_KEY_KILL_SWITCH, value);
    await refreshRuntimeConfig();
    return { ok: true, killSwitch: value };
  }
  try {
    const { error } = await supabase
      .from("site_config")
      .upsert(
        { key: CONFIG_KEY_KILL_SWITCH, value },
        { onConflict: "key" }
      );
    if (error) {
      return { ok: false, code: "db_error" };
    }
  } catch {
    return { ok: false, code: "db_exception" };
  }
  await refreshRuntimeConfig();
  return { ok: true, killSwitch: value };
}

// Test-only: reset the in-process cache + inflight between cases.
export function _resetRuntimeControllerCache() {
  clearCachedSnapshot();
  inflightLoad = null;
}

export const _internals = {
  CONFIG_KEY_ACTIVE_MODE,
  CONFIG_KEY_KILL_SWITCH,
  normalizeModeToken,
  resolveEnvOverride,
  configRowToValue,
  loadSnapshotFromDb,
  resolveSnapshot,
  getCacheTtlMs,
  recordUpsertToStubDb
};
