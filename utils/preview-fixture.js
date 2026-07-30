import { randomUUID } from "node:crypto";
import { getDeploymentSalesSite, getSalesSiteConfig } from "./sales-site.js";
import {
  getEffectiveLearningSlug,
  isGrantingOrderStatus,
  normalizeCustomerEmail
} from "./learning-course.js";

const fixtureEnabled = process.env.COMMERCE_DATA_MODE === "fixture";
const state = globalThis.__YEUBEP_PREVIEW_FIXTURE__ || {
  courses: [
    {
      id: "fixture-learning-canonical",
      slug: "thitxiennuongchaungoc",
      title: "Thịt xiên nướng Châu Ngọc",
      active: true,
      sort_order: 0,
      sales_site: null,
      learning_lesson_count: 4,
      raw_data: {}
    },
    {
      id: "fixture-yeubep-alias",
      slug: "thitxiennuongchaungoc-yeubep",
      title: "Thịt xiên nướng Châu Ngọc",
      courseName: "Thịt xiên nướng Châu Ngọc",
      price: "299.000đ",
      image_url: "https://placehold.co/900x1100?text=Thit+Xien+Nuong",
      imageUrl: "https://placehold.co/900x1100?text=Thit+Xien+Nuong",
      description: "Fixture sales alias Preview.",
      active: true,
      sort_order: 2,
      sales_site: "yeubep",
      learning_course_slug: "thitxiennuongchaungoc",
      learning_lesson_count: 4,
      raw_data: { bankName: "PREVIEW ONLY", bankAccount: "0000000000", bankOwner: "TEST", transferNote: "PREVIEW", qrImageUrl: "" }
    },
    {
      id: "fixture-yeubep-demo",
      slug: "yeubep-demo",
      title: "Yeubep Preview — Dữ liệu thử nghiệm",
      courseName: "Yeubep Preview — Dữ liệu thử nghiệm",
      price: "299.000đ",
      image_url: "https://images.unsplash.com/photo-1556910103-1c02745aae4d?auto=format&fit=crop&w=1200&q=80",
      imageUrl: "https://images.unsplash.com/photo-1556910103-1c02745aae4d?auto=format&fit=crop&w=1200&q=80",
      description: "Fixture Preview, không phải dữ liệu production.",
      active: true,
      sort_order: 1,
      sales_site: "yeubep",
      raw_data: { bankName: "PREVIEW ONLY", bankAccount: "0000000000", bankOwner: "TEST", transferNote: "PREVIEW", qrImageUrl: "" }
    },
    {
      id: "fixture-legacy-demo",
      slug: "legacy-demo",
      title: "Legacy Yeunauan Fixture",
      courseName: "Legacy Yeunauan Fixture",
      price: "199.000đ",
      active: true,
      sort_order: 1,
      sales_site: null,
      raw_data: {}
    }
  ],
  orders: []
};
globalThis.__YEUBEP_PREVIEW_FIXTURE__ = state;

export function isPreviewFixture() {
  return fixtureEnabled;
}

export function fixturePublicCourse(slug) {
  const site = getDeploymentSalesSite();
  return state.courses.find((course) =>
    course.slug === slug &&
    course.active &&
    (site === "yeunauan" ? !course.sales_site || course.sales_site === "yeunauan" : course.sales_site === "yeubep")
  ) || null;
}

export function fixtureCourses() {
  return state.courses;
}

export function fixtureSaveCourse(input) {
  const existing = state.courses.find((course) => course.id === input.id);
  const row = {
    ...(existing || {}),
    ...input,
    id: existing?.id || randomUUID(),
    title: input.title || input.courseName,
    courseName: input.title || input.courseName,
    sales_site: input.sales_site
  };
  if (existing) Object.assign(existing, row); else state.courses.push(row);
  return row;
}

export function fixtureOrders() {
  return state.orders;
}

export function fixtureUpdateOrder(id, input) {
  const order = state.orders.find((item) => item.id === id);
  if (!order) return null;
  Object.assign(order, input, { updated_at: new Date().toISOString() });
  if (Object.prototype.hasOwnProperty.call(input, "status")) {
    const action = isGrantingOrderStatus(input.status) ? "syncEnrollment" : "revokeEnrollment";
    const hasAnotherGrant = action === "revokeEnrollment" && state.orders.some((candidate) =>
      candidate.id !== order.id &&
      normalizeCustomerEmail(candidate.customer_email) === normalizeCustomerEmail(order.customer_email) &&
      getEffectiveLearningSlug(candidate) === getEffectiveLearningSlug(order) &&
      isGrantingOrderStatus(candidate.status)
    );
    order.dry_run_sync = {
      action: hasAnotherGrant ? "retainSharedEntitlement" : action,
      email: normalizeCustomerEmail(order.customer_email),
      courseSlug: getEffectiveLearningSlug(order)
    };
  }
  return order;
}

export function fixtureApproveAll(courseSlug, salesSite) {
  const selected = state.orders.filter((order) =>
    order.course_slug === courseSlug &&
    order.sales_site === salesSite &&
    order.status === "Chờ duyệt"
  );
  selected.forEach((order) => { order.status = "Đã duyệt"; });
  selected.forEach((order) => {
    order.dry_run_sync = {
      action: "syncEnrollment",
      email: normalizeCustomerEmail(order.customer_email),
      courseSlug: getEffectiveLearningSlug(order)
    };
  });
  return selected;
}

export function fixtureRegister(input, key) {
  const site = getDeploymentSalesSite();
  const duplicate = state.orders.find((order) => order.sales_site === site && order.idempotency_key === key);
  if (duplicate) return { duplicate: true, order: duplicate };
  const course = fixturePublicCourse(input.course || "donut");
  if (!course) return { error: "Không tìm thấy khóa học thuộc website này" };
  let lmsTenant = null;
  if (String(process.env.COMMERCE_DUAL_LMS_ROUTING_ENABLED || "").toLowerCase() === "true") {
    const targetSlug = getEffectiveLearningSlug(course);
    const target = state.courses.find((candidate) => candidate.slug === targetSlug);
    if (!target) return { error: "Không resolve được LMS target", code: "UNRESOLVED_LMS_TENANT" };
    lmsTenant = String(target.lms_tenant || target.sales_site || "yeunauan").trim();
    if (lmsTenant !== site) {
      return {
        error: "Liên kết dùng chung cũ không nhận đơn mới khi Dual LMS bật",
        code: "LEGACY_SHARED_MAPPING_READ_ONLY"
      };
    }
  }
  const order = {
    id: randomUUID(),
    course_slug: course.slug,
    course_title: course.title,
    learning_course_slug: getEffectiveLearningSlug(course),
    customer_email: input.gmail,
    status: "Chờ duyệt",
    sales_site: site,
    ...(lmsTenant ? { lms_tenant: lmsTenant } : {}),
    sales_host: getSalesSiteConfig(site).host,
    price_snapshot: course.price || "",
    idempotency_key: key,
    proof_image_url: "https://placehold.co/600x800?text=Preview+Bill",
    created_at: new Date().toISOString()
  };
  state.orders.push(order);
  return { duplicate: false, order };
}
