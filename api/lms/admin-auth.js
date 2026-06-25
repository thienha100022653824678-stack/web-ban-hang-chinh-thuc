import {
  verifyGoogleIdToken,
  verifyAdminSession,
  createAdminSession,
  isAdminEmail,
  cookieOptions,
  parseCookies
} from "../../utils/lms.js";

const ADMIN_SESSION_COOKIE = "admin_session_token";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const { credential, sessionToken } = req.body || {};
    const cookies = parseCookies(req);
    const existingToken = sessionToken || cookies[ADMIN_SESSION_COOKIE];

    // 1. Restore existing session
    if (existingToken && !credential) {
      const session = verifyAdminSession(existingToken);
      if (session) {
        return res.status(200).json({
          success: true,
          email: session.email,
          sessionToken: existingToken,
          sessionExpiresAt: session.expiresAt,
        });
      }
      res.setHeader("Set-Cookie", `${ADMIN_SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`);
      return res.status(401).json({
        success: false,
        error: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn",
        hint: "Vui lòng đăng nhập lại bằng Google.",
      });
    }

    // 2. Login via Google credential
    if (!credential) {
      return res.status(400).json({
        success: false,
        error: "Thiếu thông tin đăng nhập Google",
        hint: "Vui lòng đăng nhập bằng Google."
      });
    }

    let email = await verifyGoogleIdToken(credential);
    if (!email) {
      return res.status(400).json({ success: false, error: "Không lấy được email từ Google" });
    }

    if (!isAdminEmail(email)) {
      return res.status(403).json({
        success: false,
        error: "Tài khoản này không có quyền quản trị.",
        email,
        hint: "Vui lòng thêm email của bạn vào biến môi trường ADMIN_EMAILS trên Vercel."
      });
    }

    // Issue session
    const session = createAdminSession(email);
    res.setHeader(
      "Set-Cookie",
      `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(session.token)}; ${cookieOptions(session.expiresAt - Date.now())}`
    );

    return res.status(200).json({
      success: true,
      email,
      sessionToken: session.token,
      sessionExpiresAt: session.expiresAt,
    });
  } catch (err) {
    console.error("[admin-auth] Error:", err);
    return res.status(500).json({
      success: false,
      error: "Lỗi server khi xác thực admin",
      detail: err.message
    });
  }
}
