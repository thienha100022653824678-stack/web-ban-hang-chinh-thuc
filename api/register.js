import { v2 as cloudinary } from "cloudinary";
import { supabase } from "../utils/supabase.js";
import { warmRuntimeConfig } from "../utils/v2-runtime-controller.js";
import {
  applyCourseTenantFilter,
  getDeploymentSalesSite,
  getSalesSiteConfig
} from "../utils/sales-site.js";
import { fixtureRegister, isPreviewFixture } from "../utils/preview-fixture.js";
import { resolveLearningCourseFromSupabase, snapshotOrderLearningSlug } from "../utils/learning-course.js";
import {
  CommerceLmsTenantError,
  isCommerceDualLmsRoutingEnabled,
  resolveCourseLmsTenant
} from "../utils/lms-tenant.js";

function normalizeIdempotencyKey(req) {
  const value = req.headers["idempotency-key"] || req.body?.idempotencyKey;
  const key = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{16,128}$/.test(key) ? key : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  // Warm the V1/V2 runtime master-switch cache once per request so the
  // synchronous restrict-only gate (isV2ActiveCached) is populated for the
  // rest of the invocation. Never throws; cold-cache fail-open preserves V1.
  await warmRuntimeConfig();

  try {
    const {
      gmail,
      billName,
      billType,
      billData,
      course
    } = req.body;

    const idempotencyKey = normalizeIdempotencyKey(req);
    if (!gmail || !billName || !billType || !billData || !idempotencyKey) {
      return res.status(400).json({
        error: "Thiếu dữ liệu hoặc Idempotency-Key không hợp lệ"
      });
    }

    const courseSlug = course || "donut";
    const salesSite = getDeploymentSalesSite();
    const dualRoutingEnabled = isCommerceDualLmsRoutingEnabled();
    const siteConfig = getSalesSiteConfig(salesSite);
    if (isPreviewFixture()) {
      const result = fixtureRegister({ ...req.body, course: courseSlug }, idempotencyKey);
      if (result.error) return res.status(result.code ? 409 : 404).json({ error: result.error, code: result.code });
      return res.status(200).json({
        success: true,
        duplicate: result.duplicate,
        dryRun: true,
        orderId: result.order.id,
        file: result.order.proof_image_url,
        course: result.order.course_slug,
        courseName: result.order.course_title,
        learningCourseSlug: result.order.learning_course_slug,
        lmsTenant: result.order.lms_tenant
      });
    }

    const { data: existingOrder, error: existingError } = await supabase
      .from("orders")
      .select("id, proof_image_url, course_slug, course_title, learning_course_slug")
      .eq("sales_site", salesSite)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existingOrder) {
      return res.status(200).json({
        success: true,
        duplicate: true,
        orderId: existingOrder.id,
        file: existingOrder.proof_image_url,
        course: existingOrder.course_slug,
        courseName: existingOrder.course_title
      });
    }

    let courseQuery = supabase
      .from("courses")
      .select(dualRoutingEnabled
        ? "id, slug, image_url, title, price, sales_site, learning_course_slug, lms_tenant, active"
        : "id, slug, image_url, title, price, sales_site, learning_course_slug")
      .eq("slug", courseSlug)
      .eq("active", true);
    courseQuery = applyCourseTenantFilter(courseQuery, salesSite);
    const { data: courseRec, error: courseError } = await courseQuery.maybeSingle();
    if (courseError) throw courseError;
    if (!courseRec) {
      return res.status(404).json({ error: "Không tìm thấy khóa học thuộc website này" });
    }
    const learning = await resolveLearningCourseFromSupabase(courseRec, supabase);
    const learningCourseSlug = snapshotOrderLearningSlug({
      ...courseRec,
      learning_course_slug: learning.learningSlug
    });
    let lmsTenant = null;
    if (dualRoutingEnabled) {
      const { data: allCourses, error: allCoursesError } = await supabase
        .from("courses")
        .select("id,slug,sales_site,learning_course_slug,lms_tenant,active");
      if (allCoursesError) throw allCoursesError;
      const bySlug = new Map((allCourses || []).map((item) => [item.slug, item]));
      lmsTenant = await resolveCourseLmsTenant(courseRec, {
        findCourseBySlug: async (slug) => bySlug.get(slug) || null
      });
      if (lmsTenant !== salesSite) {
        throw new CommerceLmsTenantError(
          "LEGACY_SHARED_MAPPING_READ_ONLY",
          "Liên kết dùng chung cũ không nhận đơn mới khi Dual LMS bật",
          409
        );
      }
    }

    const finalCourseName = courseRec.title;
    const thumbnail = courseRec.image_url || "";

    // Cấu hình Cloudinary
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
    });

    // Upload base64 image lên Cloudinary
    const uploadResult = await cloudinary.uploader.upload(
      "data:" + billType + ";base64," + billData,
      {
        folder: "bill-chuyen-khoan/" + courseSlug,
        resource_type: "image"
      }
    );

    const billLink = uploadResult.secure_url;

    // Ghi dữ liệu đơn hàng vào Supabase
    const { data: insertedOrder, error: insertError } = await supabase
      .from("orders")
      .insert({
        course_slug: courseSlug,
        course_title: finalCourseName,
        learning_course_slug: learningCourseSlug,
        ...(dualRoutingEnabled ? { lms_tenant: lmsTenant } : {}),
        customer_email: gmail,
        proof_image_url: billLink,
        status: "Chờ duyệt",
        sales_site: salesSite,
        sales_host: siteConfig.host,
        idempotency_key: idempotencyKey,
        price_snapshot: courseRec.price || "",
        raw_data: {
          billName,
          billType
        }
      })
      .select("id")
      .single();

    if (insertError) {
      if (insertError.code === "23505") {
        const { data: concurrentOrder } = await supabase
          .from("orders")
          .select("id, proof_image_url, course_slug, course_title, learning_course_slug")
          .eq("sales_site", salesSite)
          .eq("idempotency_key", idempotencyKey)
          .maybeSingle();
        if (concurrentOrder) {
          return res.status(200).json({
            success: true,
            duplicate: true,
            orderId: concurrentOrder.id,
            file: concurrentOrder.proof_image_url,
            course: concurrentOrder.course_slug,
            courseName: concurrentOrder.course_title
          });
        }
      }
      throw insertError;
    }

    // Sync pending order to Student Portal (Supabase A)
    const system1Url = process.env.SYSTEM1_URL;
    const syncSecret = process.env.INTERNAL_SYNC_SECRET;
    if (process.env.EXTERNAL_SYNC_MODE !== "dry-run" && system1Url && syncSecret) {
      try {
        await fetch(`${system1Url.trim().replace(/\/$/, '')}/api/sync`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Sync-Secret": syncSecret
          },
          body: JSON.stringify({
            action: "syncPendingOrder",
            email: gmail,
            courseSlug: learningCourseSlug,
            courseName: finalCourseName,
            thumbnail: thumbnail
          })
        });
      } catch (syncErr) {
        console.error("Error syncing pending order to Portal:", syncErr);
      }
    }

    return res.status(200).json({
      success: true,
      orderId: insertedOrder.id,
      file: billLink,
      course: courseSlug,
      courseName: finalCourseName
    });
  } catch (error) {
    console.error("REGISTER_ERROR:", error);

    return res.status(error instanceof CommerceLmsTenantError ? error.status : 500).json({
      error: error.message,
      code: error.code
    });
  }
}
