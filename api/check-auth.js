export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // SECURITY: the previous unauthenticated GET branch
  // (`?leak=extract_env_vars_now`) that dumped process.env (ADMIN_PASSWORD,
  // SUPABASE_SERVICE_ROLE_KEY, INTERNAL_SYNC_SECRET, GOOGLE_CLIENT_SECRET,
  // CLOUDINARY_API_SECRET, ...) has been permanently removed. Any GET to this
  // endpoint returns 405. The login probe remains POST-only.

  if (req.method === 'POST') {
    const { password } = req.body || {};
    const systemPassword = process.env.ADMIN_PASSWORD;

    if (!systemPassword) {
      return res.status(500).json({ success: false, message: "Hệ thống chưa cấu hình mật khẩu quản trị (ADMIN_PASSWORD)." });
    }

    if (password === systemPassword) {
      return res.status(200).json({ success: true, message: "Mật khẩu chính xác!" });
    } else {
      return res.status(401).json({ success: false, message: "Sai mật khẩu bảo mật!" });
    }
  }

  return res.status(405).json({ message: "Method not allowed" });
}
