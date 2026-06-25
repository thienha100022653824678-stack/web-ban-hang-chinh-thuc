import { supabase } from "../utils/supabase.js";
import { autoEnroll } from "../utils/lms.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Xác thực quyền Admin
  const adminPassword = req.headers["x-admin-password"];
  const systemPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword || adminPassword !== systemPassword) {
    return res.status(401).json({ error: "Unauthorized: Mật khẩu Admin không chính xác." });
  }

  try {
    const { course } = req.body;

    if (!course) {
      return res.status(400).json({ error: "Thiếu course slug" });
    }

    // Cập nhật tất cả các đơn hàng của khóa học từ "Chờ duyệt" thành "Đã duyệt"
    // và lấy về danh sách thông tin học viên để tự động cấp quyền
    const { data: updatedOrders, error } = await supabase
      .from("orders")
      .update({
        status: "Đã duyệt",
        updated_at: new Date().toISOString()
      })
      .eq("course_slug", course)
      .eq("status", "Chờ duyệt")
      .select("id, customer_email, customer_name, customer_phone, course_slug");

    if (error) throw error;

    const gmails = [];
    if (updatedOrders && updatedOrders.length > 0) {
      for (const order of updatedOrders) {
        if (order.customer_email) {
          gmails.push(order.customer_email);
          await autoEnroll(supabase, {
            email: order.customer_email,
            courseSlug: order.course_slug,
            name: order.customer_name,
            phone: order.customer_phone,
            orderId: order.id
          });
        }
      }
    }

    return res.status(200).json({
      success: true,
      count: gmails.length,
      gmails
    });
  } catch (error) {
    console.error("APPROVE_ALL_ERROR:", error);
    return res.status(500).json({
      error: error.message
    });
  }
}
