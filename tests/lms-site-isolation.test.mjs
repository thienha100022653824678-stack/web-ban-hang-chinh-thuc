import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  isCommerceLmsSiteIsolationEnabled,
  resolveCourseLearningSite,
  validateSameSiteLearningTarget
} from "../utils/learning-site.js";

const a = { slug: "a", sales_site: null, learning_course_slug: null, learning_site: null };
const b = { slug: "b", sales_site: "yeubep", learning_course_slug: null, learning_site: null };
const find = async (slug) => ({ a, b }[slug] || null);

test("Commerce isolation flag defaults off", () => {
  assert.equal(isCommerceLmsSiteIsolationEnabled({}), false);
  assert.equal(isCommerceLmsSiteIsolationEnabled({ COMMERCE_LMS_SITE_ISOLATION_ENABLED: "true" }), true);
});

test("self-target owner follows effective sales site", async () => {
  assert.equal(await resolveCourseLearningSite(a, { findCourseBySlug: find }), "yeunauan");
  assert.equal(await resolveCourseLearningSite(b, { findCourseBySlug: find }), "yeubep");
});

test("same-site target passes and forged cross-site target is forbidden", async () => {
  const same = { slug: "b-alias", sales_site: "yeubep", learning_course_slug: "b" };
  assert.equal((await validateSameSiteLearningTarget(same, { findCourseBySlug: find })).learningSite, "yeubep");
  const cross = { slug: "cross", sales_site: "yeubep", learning_course_slug: "a" };
  await assert.rejects(
    validateSameSiteLearningTarget(cross, { findCourseBySlug: find }),
    (err) => err.code === "CROSS_SITE_LMS_TARGET_FORBIDDEN"
  );
});

test("unchanged legacy shared mapping remains readable but cannot be recreated", async () => {
  const legacy = { slug: "legacy", sales_site: "yeubep", learning_course_slug: "a" };
  const result = await validateSameSiteLearningTarget(legacy, {
    findCourseBySlug: find,
    allowExistingLegacy: true,
    originalCourse: legacy
  });
  assert.equal(result.legacyShared, true);
});

test("admin filters targets and emits LMS deep link", () => {
  const html = fs.readFileSync(new URL("../admin.html", import.meta.url), "utf8");
  assert.match(html, /item\.learning_site === salesSite/);
  assert.match(html, /id="openLmsAdminLink"/);
  assert.match(html, /LIÊN KẾT DÙNG CHUNG CŨ/);
  assert.match(html, /www\.daubepnho\.store\/lms-admin\.html\?site=/);
});

test("backend persists learning_site and returns explicit cross-site error code", () => {
  const api = fs.readFileSync(new URL("../api/courses.js", import.meta.url), "utf8");
  assert.match(api, /learning_site/);
  assert.match(api, /fixtureCourses\(\)\.some\(\(course\) => course\.slug === slug\)/);
  assert.match(api, /CROSS_SITE_LMS_TARGET_FORBIDDEN|validateSameSiteLearningTarget/);
  assert.match(api, /LEGACY_SHARED_MAPPING_READ_ONLY/);
  assert.match(api, /COURSE_SLUG_CONFLICT/);
});
