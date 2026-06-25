import { supabase } from "../../utils/supabase.js";
import { getAdminFromRequest } from "../../utils/lms.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const adminSession = getAdminFromRequest(req);
    if (!adminSession) {
      return res.status(401).json({ success: false, error: "Chưa đăng nhập admin" });
    }

    // ── GET: Read courses list + Config ───────────────────────────────────────
    if (req.method === "GET") {
      // 1. Get course slugs from courses table
      const { data: courseRows, error: courseErr } = await supabase
        .from("courses")
        .select("slug")
        .order("sort_order", { ascending: true });

      if (courseErr) throw courseErr;
      const courses = (courseRows || []).map(c => c.slug);

      // 2. Read Config from site_config
      const { data: configRows, error: configErr } = await supabase
        .from("site_config")
        .select("key, value");

      if (configErr) throw configErr;

      const config = {};
      if (configRows) {
        configRows.forEach(row => {
          const valObj = row.value;
          const val = (valObj && typeof valObj === "object" && valObj.val !== undefined) ? valObj.val : valObj;
          config[row.key] = val;
        });
      }

      return res.status(200).json({ success: true, courses, config });
    }

    // ── POST: Update Config ───────────────────────────────────────────────────
    if (req.method === "POST") {
      const { action, course, config: newConfig } = req.body || {};

      if (action !== "updateConfig") {
        return res.status(400).json({ success: false, error: "action không hợp lệ" });
      }
      if (!course) {
        return res.status(400).json({ success: false, error: "Thiếu tham số course" });
      }
      if (!newConfig || typeof newConfig !== "object") {
        return res.status(400).json({ success: false, error: "Thiếu dữ liệu config" });
      }

      for (const [field, value] of Object.entries(newConfig)) {
        const prefixedKey = `${course}_${field}`;
        const val = String(value || "").trim();

        const { error: upsertErr } = await supabase
          .from("site_config")
          .upsert({
            key: prefixedKey,
            value: { val },
            updated_at: new Date().toISOString()
          }, {
            onConflict: "key"
          });

        if (upsertErr) throw upsertErr;
      }

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (err) {
    console.error("[admin-courses] Error:", err);
    return res.status(500).json({
      success: false,
      error: "Lỗi server trong admin-courses",
      message: err.message
    });
  }
}
