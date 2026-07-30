import { supabase } from "../utils/supabase.js";
import { warmRuntimeConfig } from "../utils/v2-runtime-controller.js";
import {
  buildCourseSalesUrl,
  effectiveSalesSite,
  requireSalesSite
} from "../utils/sales-site.js";
import { fixtureCourses, fixtureSaveCourse, isPreviewFixture } from "../utils/preview-fixture.js";
import {
  getEffectiveLearningSlug,
  normalizeLearningSlug,
  resolveLearningCourse,
  resolveLearningCourseFromSupabase
} from "../utils/learning-course.js";
import {
  CommerceLmsTenantError,
  isCommerceDualLmsRoutingEnabled,
  requireDeploymentLmsTenant,
  resolveCourseLmsTenant,
  validateSameTenantLearningTarget
} from "../utils/lms-tenant.js";

function storedLearningSlug(salesSlug, value) {
  const target = normalizeLearningSlug(value);
  return !target || target === normalizeLearningSlug(salesSlug) ? null : target;
}

async function validateLearningTarget(course) {
  if (!course.learning_course_slug) return { learningSlug: course.slug, lessonCount: null, mapped: false };
  if (isPreviewFixture()) {
    return resolveLearningCourse(course, {
      findCourseBySlug: async (slug) => fixtureCourses().find((item) => item.slug === slug) || null,
      countLessons: async (slug) => fixtureCourses().find((item) => item.slug === slug)?.learning_lesson_count || 0
    });
  }
  return resolveLearningCourseFromSupabase(course, supabase);
}

function normalizeExpectedStartDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function isValidExpectedStartDateInput(value) {
  const text = String(value || "").trim();
  return text === "" || /^\d{4}-\d{2}-\d{2}$/.test(text);
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Password");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Warm the V1/V2 runtime master-switch cache once per request so the
  // synchronous restrict-only gate (isV2ActiveCached) is populated for the
  // rest of the invocation. Never throws; cold-cache fail-open preserves V1.
  await warmRuntimeConfig();

  // Xác thực quyền Admin
  const adminPassword = req.headers["x-admin-password"];
  const systemPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword || adminPassword !== systemPassword) {
    return res.status(401).json({ error: "Unauthorized: Mật khẩu Admin không chính xác hoặc trống." });
  }

  try {
    const dualRoutingEnabled = isCommerceDualLmsRoutingEnabled();
    if (req.method === "GET") {
      if (isPreviewFixture()) {
        const rows = fixtureCourses();
        const bySlug = new Map(rows.map((course) => [course.slug, course]));
        const result = [];
        for (const course of rows) {
          const lmsTenant = dualRoutingEnabled
            ? await resolveCourseLmsTenant(course, { findCourseBySlug: async (slug) => bySlug.get(slug) || null })
            : undefined;
          result.push({
            ...(course.raw_data || {}),
            ...course,
            sales_site: effectiveSalesSite(course),
            sales_url: buildCourseSalesUrl(course),
            lms_tenant: lmsTenant,
            legacy_shared_mapping: dualRoutingEnabled &&
              getEffectiveLearningSlug(course) !== course.slug &&
              lmsTenant !== effectiveSalesSite(course)
          });
        }
        return res.status(200).json(result);
      }
      // Lấy danh sách tất cả khóa học, sắp xếp theo sort_order trước, sau đó là created_at
      const { data: courses, error } = await supabase
        .from("courses")
        .select("*")
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: false });

      if (error) throw error;

      // Định dạng tương thích ngược
      const lessonCounts = new Map();
      await Promise.all([...new Set(courses.map(getEffectiveLearningSlug))].map(async (slug) => {
        const { count } = await supabase.from("lessons").select("id", { count: "exact", head: true }).eq("course_slug", slug).neq("status", "hidden");
        lessonCounts.set(slug, count || 0);
      }));
      const bySlug = new Map(courses.map((course) => [course.slug, course]));
      const lmsTenants = new Map();
      if (dualRoutingEnabled) {
        for (const course of courses) {
          lmsTenants.set(course.slug, await resolveCourseLmsTenant(course, {
            findCourseBySlug: async (slug) => bySlug.get(slug) || null
          }));
        }
      }
      const formattedCourses = courses.map((c) => ({
        ...(c.raw_data || {}),
        id: c.id,
        slug: c.slug,
        courseName: c.title,
        price: c.price || "",
        imageUrl: c.image_url || c.raw_data?.imageUrl || c.raw_data?.posterUrl || c.raw_data?.posterImageUrl || c.raw_data?.thumbnail || c.raw_data?.heroUrl || c.raw_data?.heroImageUrl || c.raw_data?.coverUrl || "",
        expected_start_date: c.expected_start_date || "",
        active: c.active,
        sort_order: c.sort_order,
        description: c.description || "",
        teacher_name: c.teacher_name || "",
        is_published: c.is_published === true,
        created_at: c.created_at,
        sync_lms_status: c.sync_lms_status || "PENDING",
        sync_portal_status: c.sync_portal_status || "PENDING",
        sync_error: c.sync_error || "",
        sales_site: effectiveSalesSite(c),
        sales_url: buildCourseSalesUrl(c),
        learning_course_slug: c.learning_course_slug || "",
        effective_learning_course_slug: getEffectiveLearningSlug(c),
        learning_lesson_count: lessonCounts.get(getEffectiveLearningSlug(c)) || 0,
        lms_tenant: dualRoutingEnabled ? lmsTenants.get(c.slug) : undefined,
        legacy_shared_mapping: dualRoutingEnabled &&
          getEffectiveLearningSlug(c) !== c.slug &&
          lmsTenants.get(c.slug) !== effectiveSalesSite(c),
        expected_start_date: c.expected_start_date || ""
      }));

      return res.status(200).json(formattedCourses);
    }

    if (req.method === "POST") {
      const {
        slug,
        courseName,
        title,
        price,
        imageUrl,
        active,
        sort_order,
        description,
        teacher_name,
        is_published,
        bankName,
        bankAccount,
        bankOwner,
        transferNote,
        qrImageUrl,
        expected_start_date,
        sales_site,
        learning_course_slug
      } = req.body;

      if (!slug || (!courseName && !title)) {
        return res.status(400).json({ error: "Thiếu thông tin bắt buộc (slug, title)" });
      }
      if (isPreviewFixture() && fixtureCourses().some((course) => course.slug === slug)) {
        return res.status(409).json({
          error: "Slug khóa học đã tồn tại. Hãy dùng suffix -yeubep hoặc -yeunauan.",
          code: "COURSE_SLUG_CONFLICT"
        });
      }
      const salesSite = dualRoutingEnabled
        ? requireDeploymentLmsTenant(sales_site)
        : requireSalesSite(sales_site);
      const storedLearning = storedLearningSlug(slug, learning_course_slug);
      const learning = await validateLearningTarget({ slug, active: active !== false, learning_course_slug: storedLearning });
      let lmsTenant = null;
      if (dualRoutingEnabled) {
        const candidate = { slug, sales_site: salesSite, learning_course_slug: storedLearning, lms_tenant: salesSite };
        const rows = isPreviewFixture() ? fixtureCourses() : (await supabase.from("courses").select("*")).data || [];
        const bySlug = new Map(rows.map((course) => [course.slug, course]));
        const validated = await validateSameTenantLearningTarget(candidate, {
          findCourseBySlug: async (target) => bySlug.get(target) || null
        });
        lmsTenant = validated.lmsTenant;
      }
      if (isPreviewFixture()) {
        const row = fixtureSaveCourse({ ...req.body, sales_site: salesSite, learning_course_slug: storedLearning, lms_tenant: lmsTenant, learning_lesson_count: learning.lessonCount });
        return res.status(201).json({ success: true, data: row, fixture: true });
      }

      if (!isValidExpectedStartDateInput(expected_start_date)) {
        return res.status(400).json({ error: "Lịch khai giảng dự kiến phải có định dạng YYYY-MM-DD" });
      }

      const { data, error } = await supabase
        .from("courses")
        .insert({
          slug,
          title: title || courseName,
          price,
          image_url: imageUrl,
          expected_start_date: normalizeExpectedStartDate(expected_start_date),
          active: active !== undefined ? active : true,
          sort_order: sort_order !== undefined ? parseInt(sort_order, 10) : 0,
          description: description || "",
          teacher_name: teacher_name || "",
          is_published: is_published === true,
          sales_site: salesSite,
          learning_course_slug: storedLearning,
          ...(dualRoutingEnabled ? { lms_tenant: lmsTenant } : {}),
          raw_data: {
            bankName: bankName || "",
            bankAccount: bankAccount || "",
            bankOwner: bankOwner || "",
            transferNote: transferNote || "",
            qrImageUrl: qrImageUrl || ""
          }
        })
        .select()
        .single();

      if (error) throw error;

      // Sync to external systems
      let syncResults = { lms: "PENDING", portal: "PENDING", error: null };
      try {
        const { syncCourseToExternalSystems } = await import("../utils/sync-helpers.js");
        syncResults = await syncCourseToExternalSystems({
          slug,
          courseName: title || courseName,
          price,
          imageUrl,
          expected_start_date,
          active,
          teacher_name
          ,learning_course_slug: storedLearning
          ,lms_tenant: lmsTenant
        });
        
        // Update database with sync status
        await supabase
          .from("courses")
          .update({
            sync_lms_status: syncResults.lms,
            sync_portal_status: syncResults.portal,
            sync_error: syncResults.error
          })
          .eq("id", data.id);
      } catch (syncErr) {
        console.error("Course sync trigger error:", syncErr);
      }

      return res.status(201).json({ success: true, data: { ...data, syncResults } });
    }

    if (req.method === "PUT") {
      const {
        id,
        slug,
        courseName,
        title,
        price,
        imageUrl,
        active,
        sort_order,
        description,
        teacher_name,
        is_published,
        bankName,
        bankAccount,
        bankOwner,
        transferNote,
        qrImageUrl,
        expected_start_date,
        sales_site,
        learning_course_slug
      } = req.body;

      if (!id) {
        return res.status(400).json({ error: "Thiếu ID khóa học để cập nhật" });
      }
      if (isPreviewFixture()) {
        const current = fixtureCourses().find((course) => course.id === id);
        if (!current) return res.status(404).json({ error: "Không tìm thấy khóa học" });
        const requestedSalesSite = Object.prototype.hasOwnProperty.call(req.body, "sales_site")
          ? sales_site
          : effectiveSalesSite(current);
        const salesSite = dualRoutingEnabled
          ? requireDeploymentLmsTenant(requestedSalesSite)
          : requireSalesSite(requestedSalesSite);
        const nextSlug = slug || current.slug;
        const storedLearning = storedLearningSlug(nextSlug,
          Object.prototype.hasOwnProperty.call(req.body, "learning_course_slug") ? learning_course_slug : current.learning_course_slug);
        const learning = await validateLearningTarget({ ...current, slug: nextSlug, learning_course_slug: storedLearning });
        let lmsTenant = current.lms_tenant || null;
        if (dualRoutingEnabled) {
          const rows = fixtureCourses();
          const bySlug = new Map(rows.map((course) => [course.slug, course]));
          const candidate = {
            ...current,
            slug: nextSlug,
            sales_site: salesSite,
            learning_course_slug: storedLearning,
            lms_tenant: storedLearning ? null : salesSite
          };
          const validated = await validateSameTenantLearningTarget(candidate, {
            findCourseBySlug: async (target) => bySlug.get(target) || null,
            allowExistingLegacy: true,
            originalCourse: current
          });
          if (validated.legacyShared &&
            (storedLearning !== current.learning_course_slug || salesSite !== effectiveSalesSite(current))) {
            throw new CommerceLmsTenantError(
              "LEGACY_SHARED_MAPPING_READ_ONLY",
              "Liên kết dùng chung cũ không được thay đổi",
              409
            );
          }
          lmsTenant = validated.legacyShared ? (current.lms_tenant || null) : validated.lmsTenant;
        }
        const row = fixtureSaveCourse({ ...req.body, sales_site: salesSite, learning_course_slug: storedLearning, lms_tenant: lmsTenant, learning_lesson_count: learning.lessonCount });
        return res.status(200).json({ success: true, data: row, fixture: true });
      }

      const { data: existingCourse, error: existingErr } = await supabase
        .from("courses")
        .select(dualRoutingEnabled
          ? "id,slug,active,image_url,expected_start_date,raw_data,sales_site,learning_course_slug,lms_tenant"
          : "id,slug,active,image_url,expected_start_date,raw_data,sales_site,learning_course_slug")
        .eq("id", id)
        .maybeSingle();

      if (existingErr) throw existingErr;
      if (!existingCourse) {
        return res.status(404).json({ error: "Không tìm thấy khóa học" });
      }
      const requestedSalesSite = Object.prototype.hasOwnProperty.call(req.body, "sales_site")
        ? sales_site
        : effectiveSalesSite(existingCourse);
      const salesSite = dualRoutingEnabled
        ? requireDeploymentLmsTenant(requestedSalesSite)
        : requireSalesSite(requestedSalesSite);

      const existingRawData = existingCourse?.raw_data || {};
      const nextSlug = slug || existingCourse.slug;
      const storedLearning = storedLearningSlug(nextSlug,
        Object.prototype.hasOwnProperty.call(req.body, "learning_course_slug") ? learning_course_slug : existingCourse.learning_course_slug);
      await validateLearningTarget({ ...existingCourse, slug: nextSlug, learning_course_slug: storedLearning });
      let lmsTenant = existingCourse.lms_tenant || null;
      if (dualRoutingEnabled) {
        const { data: allCourses, error: allCoursesError } = await supabase.from("courses").select("*");
        if (allCoursesError) throw allCoursesError;
        const bySlug = new Map((allCourses || []).map((course) => [course.slug, course]));
        const candidate = {
          ...existingCourse,
          slug: nextSlug,
          sales_site: salesSite,
          learning_course_slug: storedLearning,
          lms_tenant: storedLearning ? null : salesSite
        };
        const validated = await validateSameTenantLearningTarget(candidate, {
          findCourseBySlug: async (target) => bySlug.get(target) || null,
          allowExistingLegacy: true,
          originalCourse: existingCourse
        });
        if (validated.legacyShared &&
          (storedLearning !== existingCourse.learning_course_slug || salesSite !== effectiveSalesSite(existingCourse))) {
          throw new CommerceLmsTenantError(
            "LEGACY_SHARED_MAPPING_READ_ONLY",
            "Liên kết dùng chung cũ không được thay đổi",
            409
          );
        }
        lmsTenant = validated.legacyShared ? (existingCourse.lms_tenant || null) : validated.lmsTenant;
      }
      const nextImageUrl = String(imageUrl || "").trim();
      const hasExpectedStartDate = Object.prototype.hasOwnProperty.call(req.body, "expected_start_date");

      if (hasExpectedStartDate && !isValidExpectedStartDateInput(expected_start_date)) {
        return res.status(400).json({ error: "Lịch khai giảng dự kiến phải có định dạng YYYY-MM-DD" });
      }

      const updatePayload = {
        slug,
        title: title || courseName,
        price,
        image_url: nextImageUrl || existingCourse?.image_url || "",
        active: active !== undefined ? active : true,
        sort_order: sort_order !== undefined ? parseInt(sort_order, 10) : 0,
        description: description || "",
        teacher_name: teacher_name || "",
        sales_site: salesSite,
        learning_course_slug: storedLearning,
        ...(dualRoutingEnabled ? { lms_tenant: lmsTenant } : {}),
        raw_data: {
          ...existingRawData,
          bankName: bankName || "",
          bankAccount: bankAccount || "",
          bankOwner: bankOwner || "",
          transferNote: transferNote || "",
          qrImageUrl: qrImageUrl || ""
        }
      };

      if (hasExpectedStartDate) {
        updatePayload.expected_start_date = normalizeExpectedStartDate(expected_start_date);
      }

      if (is_published !== undefined) {
        updatePayload.is_published = is_published === true;
      }

      const { data, error } = await supabase
        .from("courses")
        .update(updatePayload)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;

      // Sync to external systems
      let syncResults = { lms: "PENDING", portal: "PENDING", error: null };
      try {
        const { syncCourseToExternalSystems } = await import("../utils/sync-helpers.js");
        syncResults = await syncCourseToExternalSystems({
          slug,
          courseName: title || courseName,
          price,
          imageUrl,
          expected_start_date,
          active,
          teacher_name
          ,learning_course_slug: storedLearning
          ,lms_tenant: lmsTenant
        });
        
        // Update database with sync status
        await supabase
          .from("courses")
          .update({
            sync_lms_status: syncResults.lms,
            sync_portal_status: syncResults.portal,
            sync_error: syncResults.error
          })
          .eq("id", id);
      } catch (syncErr) {
        console.error("Course sync trigger error:", syncErr);
      }

      return res.status(200).json({ success: true, data: { ...data, syncResults } });
    }

    if (req.method === "DELETE") {
      const { id } = req.body || req.query;

      if (!id) {
        return res.status(400).json({ error: "Thiếu ID khóa học để xóa" });
      }

      const { error } = await supabase
        .from("courses")
        .delete()
        .eq("id", id);

      if (error) throw error;

      return res.status(200).json({ success: true, message: "Đã xóa khóa học thành công" });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    console.error("COURSES_API_ERROR:", error);
    if (error?.code === "23505" && String(error?.message || "").includes("slug")) {
      return res.status(409).json({
        error: "Slug khóa học đã tồn tại. Hãy dùng suffix -yeubep hoặc -yeunauan.",
        code: "COURSE_SLUG_CONFLICT"
      });
    }
    const status = error instanceof CommerceLmsTenantError ? error.status : 500;
    return res.status(status).json({ error: error.message, code: error.code });
  }
}
