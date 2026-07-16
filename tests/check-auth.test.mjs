// tests/check-auth.test.mjs
//
// P0 security regression for api/check-auth.js.
// Asserts that the unauthenticated env-leak GET branch is gone and that
// the POST login probe still works. No real secrets required.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function buildReqRes({ method = "GET", query = {}, body = {} } = {}) {
  const req = {
    method,
    query,
    body,
    headers: {},
    socket: { remoteAddress: "203.0.113.10" }
  };
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; }
  };
  // Some handlers call res.status(N).json(...) which mutates both; others
  // call res.status(N).json(...) via chaining. The status() method already
  // returns `this` so chaining works.
  return { req, res };
}

async function loadHandler() {
  // Cache-bust so each test gets a fresh module copy that re-reads process.env.
  return (await import("../api/check-auth.js?t=" + Date.now())).default;
}

// ── P0: the env-leak branch MUST be gone ────────────────────────────────────
test("security: GET ?leak=extract_env_vars_now returns 405 and does NOT dump env", async () => {
  // Even with secrets present in process.env, the response must not contain them.
  const snap = {
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    INTERNAL_SYNC_SECRET: process.env.INTERNAL_SYNC_SECRET,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET
  };
  try {
    process.env.ADMIN_PASSWORD = "super-secret-admin-pw-should-not-leak";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "super-secret-service-role-should-not-leak";
    process.env.INTERNAL_SYNC_SECRET = "super-secret-sync-should-not-leak";
    process.env.GOOGLE_CLIENT_SECRET = "super-secret-google-should-not-leak";
    process.env.CLOUDINARY_API_SECRET = "super-secret-cloudinary-should-not-leak";

    const handler = await loadHandler();
    const { req, res } = buildReqRes({
      method: "GET",
      query: { leak: "extract_env_vars_now" }
    });
    await handler(req, res);

    // The leak branch used to return 200 with the full env dump. It must now
    // be a 405 (Method not allowed). Anything other than 405 is a regression.
    assert.equal(res.statusCode, 405, `expected 405, got ${res.statusCode}`);

    // Defense-in-depth: even if status somehow drifts, the body must never
    // contain any of the secrets we just planted.
    const text = JSON.stringify(res.body || {});
    for (const secret of [
      "super-secret-admin-pw-should-not-leak",
      "super-secret-service-role-should-not-leak",
      "super-secret-sync-should-not-leak",
      "super-secret-google-should-not-leak",
      "super-secret-cloudinary-should-not-leak"
    ]) {
      assert.equal(text.includes(secret), false, `response leaked ${secret}`);
    }
    // And the old env-key names must not appear either.
    for (const key of [
      "ADMIN_PASSWORD",
      "SUPABASE_SERVICE_ROLE_KEY",
      "INTERNAL_SYNC_SECRET",
      "GOOGLE_CLIENT_SECRET",
      "CLOUDINARY_API_SECRET"
    ]) {
      assert.equal(text.includes(key), false, `response still echoes env key ${key}`);
    }
  } finally {
    for (const [k, v] of Object.entries(snap)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("security: source of api/check-auth.js no longer returns a 200 env dump", () => {
  const src = readFileSync(join(ROOT, "api/check-auth.js"), "utf8");
  // The leak branch returned 200 with a JSON object listing the secret env
  // keys. That exact response shape (a 200 JSON body that includes both
  // ADMIN_PASSWORD and SUPABASE_SERVICE_ROLE_KEY) must be gone. A code
  // comment documenting the removal is fine; the dangerous handler is not.
  assert.equal(
    /res\.status\(200\)\.json\(\s*\{[\s\S]*ADMIN_PASSWORD[\s\S]*SUPABASE_SERVICE_ROLE_KEY/.test(src),
    false,
    "api/check-auth.js still has a 200 JSON body that dumps secrets"
  );
  // No method branch should read process.env wholesale into a response.
  assert.equal(
    /res\.status\(200\)\.json\(\s*\{[\s\S]*process\.env[\s\S]*\}/.test(src),
    false,
    "api/check-auth.js still returns process.env in a response body"
  );
});

// ── POST login probe still works ────────────────────────────────────────────
test("POST correct password → 200 success", async () => {
  const prev = process.env.ADMIN_PASSWORD;
  try {
    process.env.ADMIN_PASSWORD = "correct-password-xyz";
    const handler = await loadHandler();
    const { req, res } = buildReqRes({
      method: "POST",
      body: { password: "correct-password-xyz" }
    });
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body?.success, true);
  } finally {
    if (prev === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = prev;
  }
});

test("POST wrong password → 401", async () => {
  const prev = process.env.ADMIN_PASSWORD;
  try {
    process.env.ADMIN_PASSWORD = "correct-password-xyz";
    const handler = await loadHandler();
    const { req, res } = buildReqRes({
      method: "POST",
      body: { password: "wrong" }
    });
    await handler(req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body?.success, false);
  } finally {
    if (prev === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = prev;
  }
});

test("POST with ADMIN_PASSWORD unset → 500 fail-closed", async () => {
  const prev = process.env.ADMIN_PASSWORD;
  try {
    delete process.env.ADMIN_PASSWORD;
    const handler = await loadHandler();
    const { req, res } = buildReqRes({
      method: "POST",
      body: { password: "anything" }
    });
    await handler(req, res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body?.success, false);
  } finally {
    if (prev === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = prev;
  }
});

test("OPTIONS → 200 (CORS preflight)", async () => {
  const handler = await loadHandler();
  const { req, res } = buildReqRes({ method: "OPTIONS" });
  await handler(req, res);
  assert.equal(res.statusCode, 200);
});

test("GET without leak query → 405", async () => {
  const handler = await loadHandler();
  const { req, res } = buildReqRes({ method: "GET", query: {} });
  await handler(req, res);
  assert.equal(res.statusCode, 405);
});

test("PUT → 405", async () => {
  const handler = await loadHandler();
  const { req, res } = buildReqRes({ method: "PUT" });
  await handler(req, res);
  assert.equal(res.statusCode, 405);
});
