import { effectiveSalesSite, requireSalesSite } from "./sales-site.js";
import { getEffectiveLearningSlug } from "./learning-course.js";

export const LEARNING_SITES = Object.freeze(["yeunauan", "yeubep"]);

export class CommerceLearningSiteError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function isCommerceLmsSiteIsolationEnabled(env = process.env) {
  return String(env.COMMERCE_LMS_SITE_ISOLATION_ENABLED || "").trim().toLowerCase() === "true";
}

export async function resolveCourseLearningSite(course, { findCourseBySlug }) {
  if (!course) throw new CommerceLearningSiteError("UNRESOLVED_LEARNING_SITE", "Không tìm thấy course", 404);
  const explicit = String(course.learning_site || "").trim();
  if (explicit) return requireSalesSite(explicit);

  const target = getEffectiveLearningSlug(course);
  if (target === String(course.slug || "").trim()) {
    return effectiveSalesSite(course);
  }
  const canonical = await findCourseBySlug(target);
  if (!canonical || getEffectiveLearningSlug(canonical) !== canonical.slug) {
    throw new CommerceLearningSiteError("UNRESOLVED_LEARNING_SITE", "Không resolve được LMS target", 409);
  }
  return resolveCourseLearningSite(canonical, { findCourseBySlug });
}

export async function validateSameSiteLearningTarget(course, {
  findCourseBySlug,
  allowExistingLegacy = false,
  originalCourse = null
}) {
  const salesSite = requireSalesSite(course.sales_site);
  const targetSlug = getEffectiveLearningSlug(course);
  if (targetSlug === course.slug) {
    return { learningSite: salesSite, target: course, legacyShared: false };
  }
  const target = await findCourseBySlug(targetSlug);
  if (!target) {
    throw new CommerceLearningSiteError("UNRESOLVED_LEARNING_SITE", "Không tìm thấy LMS target", 409);
  }
  const targetSite = await resolveCourseLearningSite(target, { findCourseBySlug });
  if (targetSite !== salesSite) {
    const unchangedLegacy = allowExistingLegacy &&
      originalCourse &&
      getEffectiveLearningSlug(originalCourse) === targetSlug &&
      effectiveSalesSite(originalCourse) === salesSite;
    if (!unchangedLegacy) {
      throw new CommerceLearningSiteError(
        "CROSS_SITE_LMS_TARGET_FORBIDDEN",
        "LMS target phải thuộc cùng logical site",
        409
      );
    }
    return { learningSite: targetSite, target, legacyShared: true };
  }
  return { learningSite: targetSite, target, legacyShared: false };
}

