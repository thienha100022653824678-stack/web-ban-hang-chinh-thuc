import { effectiveSalesSite, getDeploymentSalesSite, requireSalesSite } from "./sales-site.js";
import { getEffectiveLearningSlug } from "./learning-course.js";

export const LMS_TENANTS = Object.freeze(["yeunauan", "yeubep"]);
const LMS_TENANT_SET = new Set(LMS_TENANTS);

export class CommerceLmsTenantError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function isCommerceDualLmsRoutingEnabled(env = process.env) {
  return String(env.COMMERCE_DUAL_LMS_ROUTING_ENABLED || "").trim().toLowerCase() === "true";
}

export async function resolveCourseLmsTenant(course, { findCourseBySlug }) {
  return resolveCourseLmsTenantInternal(course, { findCourseBySlug }, new Set());
}

export function requireLmsTenant(value) {
  const tenant = String(value || "").trim().toLowerCase();
  if (!LMS_TENANT_SET.has(tenant)) {
    throw new CommerceLmsTenantError("INVALID_LMS_TENANT", "LMS tenant không hợp lệ", 400);
  }
  return tenant;
}

export function requireDeploymentLmsTenant(value) {
  const requested = requireSalesSite(value);
  const deployed = getDeploymentSalesSite();
  if (requested !== deployed) {
    throw new CommerceLmsTenantError(
      "COURSE_LMS_TENANT_MISMATCH",
      "Website bán hàng không khớp LMS tenant của deployment",
      403
    );
  }
  return deployed;
}

async function resolveCourseLmsTenantInternal(course, { findCourseBySlug }, visited) {
  if (!course) throw new CommerceLmsTenantError("UNRESOLVED_LMS_TENANT", "Không tìm thấy course", 404);
  const slug = String(course.slug || "").trim();
  if (!slug || visited.has(slug)) {
    throw new CommerceLmsTenantError("UNRESOLVED_LMS_TENANT", "LMS target bị vòng lặp", 409);
  }
  visited.add(slug);
  const explicit = String(course.lms_tenant || "").trim();
  if (explicit) return requireLmsTenant(explicit);

  const target = getEffectiveLearningSlug(course);
  if (target === String(course.slug || "").trim()) {
    return effectiveSalesSite(course);
  }
  const canonical = await findCourseBySlug(target);
  if (!canonical || canonical.active === false || getEffectiveLearningSlug(canonical) !== canonical.slug) {
    throw new CommerceLmsTenantError("UNRESOLVED_LMS_TENANT", "Không resolve được LMS target", 409);
  }
  return resolveCourseLmsTenantInternal(canonical, { findCourseBySlug }, visited);
}

export async function resolveOrderLmsTenant(order, { findCourseBySlug }) {
  const explicit = String(order?.lms_tenant || "").trim();
  const targetSlug = getEffectiveLearningSlug(order);
  const target = await findCourseBySlug(targetSlug);
  if (!target) {
    throw new CommerceLmsTenantError("UNRESOLVED_LMS_TENANT", "Không tìm thấy canonical order target", 409);
  }
  const targetTenant = await resolveCourseLmsTenant(target, { findCourseBySlug });
  if (explicit && requireLmsTenant(explicit) !== targetTenant) {
    throw new CommerceLmsTenantError(
      "COURSE_LMS_TENANT_MISMATCH",
      "Order LMS tenant không khớp canonical target",
      409
    );
  }
  return explicit ? requireLmsTenant(explicit) : targetTenant;
}

export async function validateSameTenantLearningTarget(course, {
  findCourseBySlug,
  allowExistingLegacy = false,
  originalCourse = null
}) {
  const salesSite = requireSalesSite(course.sales_site);
  const targetSlug = getEffectiveLearningSlug(course);
  if (targetSlug === course.slug) {
    return { lmsTenant: salesSite, target: course, legacyShared: false };
  }
  const target = await findCourseBySlug(targetSlug);
  if (!target) {
    throw new CommerceLmsTenantError("UNRESOLVED_LMS_TENANT", "Không tìm thấy LMS target", 409);
  }
  const targetSite = await resolveCourseLmsTenant(target, { findCourseBySlug });
  if (targetSite !== salesSite) {
    const unchangedLegacy = allowExistingLegacy &&
      originalCourse &&
      getEffectiveLearningSlug(originalCourse) === targetSlug &&
      effectiveSalesSite(originalCourse) === salesSite;
    if (!unchangedLegacy) {
      throw new CommerceLmsTenantError(
        "CROSS_LMS_TARGET_FORBIDDEN",
        "LMS target phải thuộc cùng LMS tenant",
        409
      );
    }
    return { lmsTenant: targetSite, target, legacyShared: true };
  }
  return { lmsTenant: targetSite, target, legacyShared: false };
}

