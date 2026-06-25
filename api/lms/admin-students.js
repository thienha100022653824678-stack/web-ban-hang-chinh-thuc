import { supabase } from "../../utils/supabase.js";
import { getAdminFromRequest, normalizeEmail } from "../../utils/lms.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const adminSession = getAdminFromRequest(req);
    if (!adminSession) {
      return res.status(401).json({ success: false, error: "Chưa đăng nhập admin" });
    }

    // ── GET: List students with search ────────────────────────────────────────
    if (req.method === "GET") {
      const { search } = req.query || {};
      let query = supabase.from("students").select("*");

      if (search) {
        const s = `%${search.trim()}%`;
        query = query.or(`email.ilike.${s},full_name.ilike.${s},phone.ilike.${s}`);
      }

      const { data: students, error } = await query.order("created_at", { ascending: false });

      if (error) throw error;
      return res.status(200).json({ success: true, students });
    }

    // ── POST: Create Student ──────────────────────────────────────────────────
    if (req.method === "POST") {
      const { email, full_name, phone, status, note } = req.body || {};
      if (!email) {
        return res.status(400).json({ success: false, error: "Thiếu thông tin email học viên" });
      }

      const cleanEmail = normalizeEmail(email);

      const { data, error } = await supabase
        .from("students")
        .insert({
          email: cleanEmail,
          full_name: full_name || null,
          phone: phone || null,
          status: status || "active",
          note: note || null,
          updated_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          return res.status(400).json({ success: false, error: "Email học viên này đã tồn tại trên hệ thống" });
        }
        throw error;
      }

      return res.status(200).json({ success: true, student: data });
    }

    // ── PUT: Update Student ───────────────────────────────────────────────────
    if (req.method === "PUT") {
      const { id, email, full_name, phone, status, note } = req.body || {};
      if (!id || !email) {
        return res.status(400).json({ success: false, error: "Thiếu ID hoặc email học viên" });
      }

      const cleanEmail = normalizeEmail(email);

      const { data, error } = await supabase
        .from("students")
        .update({
          email: cleanEmail,
          full_name: full_name || null,
          phone: phone || null,
          status: status || "active",
          note: note || null,
          updated_at: new Date().toISOString()
        })
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return res.status(200).json({ success: true, student: data });
    }

    // ── DELETE: Delete Student ────────────────────────────────────────────────
    if (req.method === "DELETE") {
      const { id } = req.query || {};
      if (!id) {
        return res.status(400).json({ success: false, error: "Thiếu ID học viên để xóa" });
      }

      const { error } = await supabase
        .from("students")
        .delete()
        .eq("id", id);

      if (error) throw error;
      return res.status(200).json({ success: true, message: "Đã xóa học viên thành công" });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (err) {
    console.error("[admin-students] Error:", err);
    return res.status(500).json({
      success: false,
      error: "Lỗi hệ thống khi quản lý học viên",
      message: err.message
    });
  }
}
