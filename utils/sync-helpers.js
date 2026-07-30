import { supabase } from "./supabase.js";
import {
  enqueueCourseSyncEvent,
  enqueueEnrollmentSyncEvent,
  isV2OutboxShadowMode
} from "./v2-outbox.js";
import { getEffectiveLearningSlug } from "./learning-course.js";
import { isCommerceDualLmsRoutingEnabled } from "./lms-tenant.js";

function isExternalDryRun() {
  return String(process.env.EXTERNAL_SYNC_MODE || "").trim().toLowerCase() === "dry-run";
}

function dryRunResult(action, courseSlug, payload, extra = {}) {
  return {
    lms: "DRY_RUN",
    portal: "DRY_RUN",
    error: null,
    dryRun: true,
    action,
    courseSlug,
    payload,
    ...extra
  };
}

async function writeV2OutboxShadow(label, operation) {
  if (!isV2OutboxShadowMode()) return;
  try {
    await operation();
  } catch (error) {
    console.warn(`[v2-outbox] ${label} shadow write skipped:`, error.message);
  }
}

export async function syncCourseToExternalSystems(courseData) {
  const learningSlug = getEffectiveLearningSlug(courseData);
  if (learningSlug && learningSlug !== courseData.slug) {
    const mappedResult = {
      lms: "MAPPED_NOT_REQUIRED",
      portal: "MAPPED_NOT_REQUIRED",
      error: null,
      learningCourseSlug: learningSlug,
      mapped: true
    };
    return isExternalDryRun()
      ? { ...mappedResult, dryRun: true, action: "syncCourse", courseSlug: learningSlug, payload: null }
      : mappedResult;
  }

  const dryRunCoursePayload = {
    action: "syncCourse",
    slug: learningSlug,
    title: courseData.courseName || courseData.title,
    subtitle: courseData.subtitle || "",
    price: courseData.price || "",
    imageUrl: courseData.imageUrl || courseData.image_url || "",
    active: courseData.active !== undefined ? courseData.active : true,
    isPublished: !!courseData.is_published,
    teacher: courseData.teacher_name || "",
    ...(isCommerceDualLmsRoutingEnabled() ? { lmsTenant: courseData.lms_tenant } : {})
  };
  if (Object.prototype.hasOwnProperty.call(courseData, "expected_start_date")) {
    dryRunCoursePayload.expected_start_date = courseData.expected_start_date;
  }
  if (isExternalDryRun()) {
    return dryRunResult("syncCourse", learningSlug, {
      lms: dryRunCoursePayload,
      portal: {
        action: "syncCourse",
        courseSlug: learningSlug,
        title: dryRunCoursePayload.title,
        imageUrl: dryRunCoursePayload.imageUrl,
        active: dryRunCoursePayload.active,
        isPublished: dryRunCoursePayload.isPublished,
        ...(Object.prototype.hasOwnProperty.call(dryRunCoursePayload, "expected_start_date")
          ? { expected_start_date: dryRunCoursePayload.expected_start_date }
          : {})
      }
    });
  }

  const secret = process.env.INTERNAL_SYNC_SECRET;
  const sys1Url = process.env.SYSTEM1_URL;
  const sys3Url = process.env.SYSTEM3_URL;
  const results = { lms: "SKIPPED", portal: "SKIPPED", error: null };
  
  if (!secret) {
    results.error = "Missing INTERNAL_SYNC_SECRET";
    return results;
  }

  // Fetch is_published from Supabase B to verify publish status
  let isPublished = false;
  try {
    const { data: courseRow } = await supabase
      .from("courses")
      .select("is_published")
      .eq("slug", courseData.slug)
      .maybeSingle();
    if (courseRow) {
      isPublished = !!courseRow.is_published;
    }
  } catch (err) {
    console.error("Error fetching is_published during syncCourse:", err);
  }
  
  const payload = {
    action: "syncCourse",
    slug: courseData.slug,
    title: courseData.courseName || courseData.title,
    subtitle: courseData.subtitle || "",
    price: courseData.price || "",
    imageUrl: courseData.imageUrl || courseData.image_url || "",
    active: courseData.active !== undefined ? courseData.active : true,
    isPublished: isPublished,
    teacher: courseData.teacher_name || "",
    ...(isCommerceDualLmsRoutingEnabled() ? { lmsTenant: courseData.lms_tenant } : {})
  };
  const hasExpectedStartDate = Object.prototype.hasOwnProperty.call(courseData, "expected_start_date");
  if (hasExpectedStartDate) {
    payload.expected_start_date = courseData.expected_start_date;
  }

  await writeV2OutboxShadow("course sync", () => enqueueCourseSyncEvent({
    ...courseData,
    slug: payload.slug,
    title: payload.title,
    image_url: payload.imageUrl,
    expected_start_date: hasExpectedStartDate ? payload.expected_start_date : courseData.expected_start_date,
    active: payload.active
  }));
  
  // Call System 3 (LMS)
  if (sys3Url) {
    try {
      const res = await fetch(`${sys3Url.trim().replace(/\/$/, '')}/api/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sync-Secret": secret
        },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        results.lms = "SUCCESS";
      } else {
        const errData = await res.json().catch(() => ({}));
        results.lms = "FAILED";
        results.error = `LMS failed: ${errData.error || res.statusText}`;
      }
    } catch (err) {
      results.lms = "FAILED";
      results.error = `LMS error: ${err.message}`;
    }
  }
  
  // Call System 1 (Portal)
  if (sys1Url) {
    try {
      const res = await fetch(`${sys1Url.trim().replace(/\/$/, '')}/api/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sync-Secret": secret
        },
        body: JSON.stringify({
          action: "syncCourse",
          courseSlug: payload.slug,
          title: payload.title,
          imageUrl: payload.imageUrl,
          active: payload.active,
          isPublished: payload.isPublished,
          ...(hasExpectedStartDate ? { expected_start_date: payload.expected_start_date } : {})
        })
      });
      if (res.ok) {
        const resData = await res.json().catch(() => ({}));
        let portalStatus = "SUCCESS";
        if (resData.projectRef) {
          portalStatus += ` (DB: ${resData.projectRef})`;
        }
        if (resData.postId) {
          portalStatus += ` (PostID: ${resData.postId})`;
        }
        results.portal = portalStatus;
      } else {
        const errData = await res.json().catch(() => ({}));
        results.portal = "FAILED";
        results.error = (results.error ? results.error + " | " : "") + `Portal failed: ${errData.error || res.statusText}`;
      }
    } catch (err) {
      results.portal = "FAILED";
      results.error = (results.error ? results.error + " | " : "") + `Portal error: ${err.message}`;
    }
  }
  
  return results;
}

export async function syncEnrollmentToExternalSystems(orderData, actionType) {
  const email = orderData.customer_email || orderData.gmail;
  const courseSlug = getEffectiveLearningSlug(orderData);
  const action = actionType === "create" ? "syncEnrollment" : "revokeEnrollment";

  if (!email || !courseSlug) {
    const results = { lms: "SKIPPED", portal: "SKIPPED", error: null };
    results.error = "Missing email or course slug";
    return results;
  }

  const lmsTenant = String(orderData.lms_tenant || orderData.effective_lms_tenant || "").trim();
  if (isCommerceDualLmsRoutingEnabled() && !lmsTenant) {
    return {
      lms: "FAILED",
      portal: "SKIPPED",
      error: "UNRESOLVED_LMS_TENANT"
    };
  }
  const lmsPayload = {
    action,
    email,
    courseSlug,
    ...(isCommerceDualLmsRoutingEnabled() ? { lmsTenant } : {})
  };
  const portalPayload = { action, email, courseSlug };
  if (isExternalDryRun()) {
    return dryRunResult(action, courseSlug, {
      lms: lmsPayload,
      portal: portalPayload
    });
  }

  const secret = process.env.INTERNAL_SYNC_SECRET;
  const sys1Url = process.env.SYSTEM1_URL;
  const sys3Url = process.env.SYSTEM3_URL;
  const results = { lms: "SKIPPED", portal: "SKIPPED", error: null };
  if (!secret) {
    results.error = "Missing INTERNAL_SYNC_SECRET";
    return results;
  }

  await writeV2OutboxShadow("enrollment sync", () => enqueueEnrollmentSyncEvent({
    ...orderData,
    email,
    course_slug: courseSlug,
    updated_at: orderData.updated_at || orderData.created_at
  }, actionType === "create" ? "upserted" : "revoked"));
  
  // Call System 3 (LMS)
  if (sys3Url) {
    try {
      const res = await fetch(`${sys3Url.trim().replace(/\/$/, '')}/api/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sync-Secret": secret
        },
        body: JSON.stringify(lmsPayload)
      });
      if (res.ok) {
        results.lms = "SUCCESS";
      } else {
        const errData = await res.json().catch(() => ({}));
        results.lms = "FAILED";
        results.error = `LMS failed: ${errData.error || res.statusText}`;
      }
    } catch (err) {
      results.lms = "FAILED";
      results.error = `LMS error: ${err.message}`;
    }
  }
  
  // Call System 1 (Portal)
  if (sys1Url) {
    try {
      const res = await fetch(`${sys1Url.trim().replace(/\/$/, '')}/api/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sync-Secret": secret
        },
        body: JSON.stringify(portalPayload)
      });
      if (res.ok) {
        const resData = await res.json().catch(() => ({}));
        let portalStatus = "SUCCESS";
        if (resData.projectRef) {
          portalStatus += ` (DB: ${resData.projectRef})`;
        }
        if (resData.postId) {
          portalStatus += ` (PostID: ${resData.postId})`;
        }
        results.portal = portalStatus;
      } else {
        const errData = await res.json().catch(() => ({}));
        results.portal = "FAILED";
        results.error = (results.error ? results.error + " | " : "") + `Portal failed: ${errData.error || res.statusText}`;
      }
    } catch (err) {
      results.portal = "FAILED";
      results.error = (results.error ? results.error + " | " : "") + `Portal error: ${err.message}`;
    }
  }
  
  // Trigger Email số 1 if enrollment is successfully created (approved)
  if (actionType === "create" && results.lms === "SUCCESS" && results.portal.startsWith("SUCCESS")) {
    try {
      await sendApprovalEmail(email, orderData.course_title || courseSlug);
    } catch (mailErr) {
      console.error("[Email Hook Error] Failed to send approval email:", mailErr);
    }
  }
  
  return results;
}

export async function sendApprovalEmail(email, courseName) {
  console.log(`[Email Hook - TODO] Gửi email số 1 duyệt khóa học đến ${email} cho khóa ${courseName}`);
  
  // TODO: Cấu hình SMTP / Resend / Gmail API tại đây để gửi email thực tế
  // Ví dụ sử dụng Resend:
  // const resend = new Resend(process.env.RESEND_API_KEY);
  // await resend.emails.send({
  //   from: 'Culinary Academy <academy@yeunauan.live>',
  //   to: email,
  //   subject: 'Khóa học của bạn đã được xét duyệt',
  //   html: `<p>Khóa học <strong>${courseName}</strong> đã được Admin xét duyệt.</p>
  //          <p>Vui lòng truy cập: <a href="https://yeunauan.live/my-courses">https://yeunauan.live/my-courses</a> để xem trạng thái khóa học.</p>`
  // });
}
