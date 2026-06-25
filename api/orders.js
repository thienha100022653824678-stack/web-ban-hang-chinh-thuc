import { supabase } from "../utils/supabase.js";
import { autoEnroll } from "../utils/lms.js";

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Password");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Xác thực quyền Admin
  const adminPassword = req.headers["x-admin-password"];
  const systemPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword || adminPassword !== systemPassword) {
    return res.status(401).json({ error: "Unauthorized: Mật khẩu Admin không chính xác hoặc trống." });
  }

  try {
    if (req.method === "GET") {
      const { data: orders, error } = await supabase
        .from("orders")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;

      // Trả về danh sách đơn hàng đã format tương thích ngược cả tiếng Việt và tiếng Anh
      const formattedOrders = orders.map((o) => {
        const timeFormatted = new Date(o.created_at).toLocaleString("vi-VN", {
          timeZone: "Asia/Ho_Chi_Minh"
        });

        return {
          id: o.id,
          created_at: o.created_at,
          "Thời gian": timeFormatted,
          time: timeFormatted,
          "Course": o.course_slug,
          course: o.course_slug,
          "Tên khóa học": o.course_title,
          courseName: o.course_title,
          "Gmail": o.customer_email,
          gmail: o.customer_email,
          "Link bill": o.proof_image_url,
          billLink: o.proof_image_url,
          "Trạng thái": o.status,
          status: o.status,
          note: o.note || "",
          customer_phone: o.customer_phone || "",
          customer_name: o.customer_name || "",
          ...(o.raw_data || {})
        };
      });

      return res.status(200).json(formattedOrders);
    }

    if (req.method === "PUT") {
      const { id, status, note, customer_name, customer_phone } = req.body;

      if (!id) {
        return res.status(400).json({ error: "Thiếu ID đơn hàng để cập nhật" });
      }

      // Chuẩn bị dữ liệu cập nhật
      const updateData = {
        updated_at: new Date().toISOString()
      };
      
      if (status !== undefined) updateData.status = status;
      if (note !== undefined) updateData.note = note;
      if (customer_name !== undefined) updateData.customer_name = customer_name;
      if (customer_phone !== undefined) updateData.customer_phone = customer_phone;

      const { data, error } = await supabase
        .from("orders")
        .update(updateData)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;

      // Tự động cấp quyền học nếu đơn được chuyển trạng thái thành "Đã duyệt"
      if (status === "Đã duyệt" && data) {
        await autoEnroll(supabase, {
          email: data.customer_email,
          courseSlug: data.course_slug,
          name: data.customer_name,
          phone: data.customer_phone,
          orderId: data.id
        });
      }

      return res.status(200).json({ success: true, data });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    console.error("ORDERS_API_ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
}
