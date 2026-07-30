import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  isCommerceDualLmsRoutingEnabled,
  requireDeploymentLmsTenant,
  requireLmsTenant,
  resolveCourseLmsTenant,
  validateSameTenantLearningTarget
} from "../utils/lms-tenant.js";

const a = { slug: "a", sales_site: null, learning_course_slug: null, lms_tenant: null };
const b = { slug: "b", sales_site: "yeubep", learning_course_slug: null, lms_tenant: null };
const find = async (slug) => ({ a, b }[slug] || null);

test("Commerce isolation flag defaults off", () => {
  assert.equal(isCommerceDualLmsRoutingEnabled({}), false);
  assert.equal(isCommerceDualLmsRoutingEnabled({ COMMERCE_DUAL_LMS_ROUTING_ENABLED: "true" }), true);
});

test("self-target owner follows effective sales site", async () => {
  assert.equal(await resolveCourseLmsTenant(a, { findCourseBySlug: find }), "yeunauan");
  assert.equal(await resolveCourseLmsTenant(b, { findCourseBySlug: find }), "yeubep");
});

test("same-tenant target passes and forged cross-LMS target is forbidden", async () => {
  const same = { slug: "b-alias", sales_site: "yeubep", learning_course_slug: "b" };
  assert.equal((await validateSameTenantLearningTarget(same, { findCourseBySlug: find })).lmsTenant, "yeubep");
  const cross = { slug: "cross", sales_site: "yeubep", learning_course_slug: "a" };
  await assert.rejects(
    validateSameTenantLearningTarget(cross, { findCourseBySlug: find }),
    (err) => err.code === "CROSS_LMS_TARGET_FORBIDDEN"
  );
});

test("unchanged legacy shared mapping remains readable but cannot be recreated", async () => {
  const legacy = { slug: "legacy", sales_site: "yeubep", learning_course_slug: "a" };
  const result = await validateSameTenantLearningTarget(legacy, {
    findCourseBySlug: find,
    allowExistingLegacy: true,
    originalCourse: legacy
  });
  assert.equal(result.legacyShared, true);
});

test("admin filters targets and emits LMS deep link", () => {
  const html = fs.readFileSync(new URL("../admin.html", import.meta.url), "utf8");
  assert.match(html, /item\.lms_tenant === salesSite/);
  assert.match(html, /id="openLmsAdminLink"/);
  assert.match(html, /LIÊN KẾT DÙNG CHUNG CŨ/);
  assert.match(html, /www\.daubepnho\.store\/lms-admin\.html\?lms=/);
});

test("backend persists lms_tenant and returns explicit cross-site error code", () => {
  const api = fs.readFileSync(new URL("../api/courses.js", import.meta.url), "utf8");
  assert.match(api, /lms_tenant/);
  assert.match(api, /CROSS_LMS_TARGET_FORBIDDEN|validateSameTenantLearningTarget/);
  assert.match(api, /LEGACY_SHARED_MAPPING_READ_ONLY/);
  assert.match(api, /COURSE_SLUG_CONFLICT/);
});

test("invalid explicit LMS tenant uses the stable INVALID_LMS_TENANT contract", () => {
  assert.equal(requireLmsTenant(" yeubep "), "yeubep");
  assert.throws(() => requireLmsTenant("forged"), (error) =>
    error.code === "INVALID_LMS_TENANT" && error.status === 400
  );
});

test("feature-on course writes are bound to the deployment SALES_SITE", () => {
  const previous = process.env.SALES_SITE;
  process.env.SALES_SITE = "yeunauan";
  try {
    assert.equal(requireDeploymentLmsTenant("yeunauan"), "yeunauan");
    assert.throws(() => requireDeploymentLmsTenant("yeubep"), (error) =>
      error.code === "COURSE_LMS_TENANT_MISMATCH" && error.status === 403
    );
  } finally {
    if (previous === undefined) delete process.env.SALES_SITE;
    else process.env.SALES_SITE = previous;
  }
});

test("new orders snapshot server-resolved LMS tenant and reject legacy cross-LMS aliases", () => {
  const source = fs.readFileSync(new URL("../api/register.js", import.meta.url), "utf8");
  assert.match(source, /lms_tenant:\s*lmsTenant/);
  assert.match(source, /LEGACY_SHARED_MAPPING_READ_ONLY/);
  assert.match(source, /resolveCourseLmsTenant/);
  assert.doesNotMatch(source, /req\.body\?\.lms_tenant|req\.body\.lms_tenant/);
});

test("approve, resync and revoke resolve immutable order routing server-side", () => {
  const orders = fs.readFileSync(new URL("../api/orders.js", import.meta.url), "utf8");
  const approveAll = fs.readFileSync(new URL("../api/approve-all.js", import.meta.url), "utf8");
  for (const source of [orders, approveAll]) {
    assert.match(source, /resolveOrderLmsTenant/);
    assert.match(source, /effective_lms_tenant/);
  }
  assert.match(orders, /approve|resync|revoke/);
});

test("feature-off database selects do not require the additive tenant column", () => {
  for (const file of ["../api/register.js", "../api/approve-all.js"]) {
    const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /(?:dualRoutingEnabled|isCommerceDualLmsRoutingEnabled\(\))[\s\S]{0,120}\?/);
  }
});

test("Preview fixture snapshots tenant and rejects a legacy cross-LMS order", () => {
  const fixture = fs.readFileSync(new URL("../utils/preview-fixture.js", import.meta.url), "utf8");
  const register = fs.readFileSync(new URL("../api/register.js", import.meta.url), "utf8");
  assert.match(fixture, /COMMERCE_DUAL_LMS_ROUTING_ENABLED/);
  assert.match(fixture, /LEGACY_SHARED_MAPPING_READ_ONLY/);
  assert.match(fixture, /lms_tenant:\s*lmsTenant/);
  assert.match(register, /lmsTenant:\s*result\.order\.lms_tenant/);
});
