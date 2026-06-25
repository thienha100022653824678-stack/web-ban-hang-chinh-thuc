import { OAuth2Client } from "google-auth-library";
import crypto from "crypto";

const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const STUDENT_SESSION_COOKIE = "course_session_token";
const ADMIN_SESSION_COOKIE = "admin_session_token";

// Normalizes email string
export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// Check if email is in ADMIN_EMAILS list
export function getAdminEmails() {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email) {
  return getAdminEmails().includes(normalizeEmail(email));
}

// Session secrets
function sessionSecrets() {
  return [
    process.env.SESSION_SECRET,
    process.env.GOOGLE_CLIENT_ID,
    "fallback-session-secret"
  ]
    .filter(Boolean)
    .map(s => String(s).trim())
    .filter((s, idx, self) => s && self.indexOf(s) === idx);
}

function sessionSecret() {
  return sessionSecrets()[0] || "fallback-session-secret";
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signPayload(payloadBase64, secret = sessionSecret()) {
  return crypto
    .createHmac("sha256", secret)
    .update(payloadBase64)
    .digest("base64url");
}

// Student Sessions
export function createStudentSession(email) {
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = { email: normalizeEmail(email), exp: expiresAt };
  const payloadBase64 = base64url(JSON.stringify(payload));
  const signature = signPayload(payloadBase64);

  return {
    token: `${payloadBase64}.${signature}`,
    expiresAt
  };
}

export function verifyStudentSession(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadBase64, signature] = parts;
  const validSignature = sessionSecrets().some(secret => {
    const expectedSignature = signPayload(payloadBase64, secret);
    try {
      const a = Buffer.from(signature);
      const b = Buffer.from(expectedSignature);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  });

  if (!validSignature) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf8"));
    if (!payload.email || !payload.exp) return null;
    if (Date.now() > Number(payload.exp)) return null;

    return {
      email: normalizeEmail(payload.email),
      expiresAt: Number(payload.exp)
    };
  } catch {
    return null;
  }
}

// Admin Sessions
export function createAdminSession(email) {
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = { email: normalizeEmail(email), role: "admin", exp: expiresAt };
  const payloadBase64 = base64url(JSON.stringify(payload));
  const signature = signPayload(payloadBase64);

  return {
    token: `${payloadBase64}.${signature}`,
    expiresAt
  };
}

export function verifyAdminSession(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadBase64, signature] = parts;
  const validSignature = sessionSecrets().some(secret => {
    const expectedSignature = signPayload(payloadBase64, secret);
    try {
      const a = Buffer.from(signature);
      const b = Buffer.from(expectedSignature);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  });

  if (!validSignature) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf8"));
    if (!payload.email || !payload.exp || payload.role !== "admin") return null;
    if (Date.now() > Number(payload.exp)) return null;
    if (!isAdminEmail(payload.email)) return null;

    return {
      email: normalizeEmail(payload.email),
      expiresAt: Number(payload.exp)
    };
  } catch {
    return null;
  }
}

// Extract cookies
export function parseCookies(req) {
  const header = req.headers?.cookie || "";
  return header.split(";").reduce((cookies, part) => {
    const index = part.indexOf("=");
    if (index === -1) return cookies;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
    }
    return cookies;
  }, {});
}

// Get admin session from request
export function getAdminFromRequest(req) {
  const cookies = parseCookies(req);
  const token =
    req.body?.sessionToken ||
    req.query?.sessionToken ||
    (req.headers?.authorization || "").replace(/^Bearer\s+/i, "") ||
    cookies[ADMIN_SESSION_COOKIE];
  if (!token) return null;
  return verifyAdminSession(token);
}

// Google ID token verify
export async function verifyGoogleIdToken(credential) {
  if (!credential) return null;
  const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  const ticket = await client.verifyIdToken({
    idToken: credential,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  return normalizeEmail(payload?.email);
}

// Cookie Options helper
export function cookieOptions(maxAgeMs) {
  const parts = [
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];
  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

// Bunny Stream Token Signing
function extractIframeSrc(input) {
  const text = String(input || "").trim();
  const match = text.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  return match?.[1] ? match[1].trim() : text;
}

function parseBunnyVideoIdAndLibraryId(videoUrl) {
  let src = extractIframeSrc(videoUrl).replace(/&amp;/g, "&").trim();
  if (!src) return null;

  try {
    const url = new URL(src);
    const host = url.hostname.replace(/^www\./, "");
    if (
      host !== "player.mediadelivery.net" &&
      host !== "iframe.mediadelivery.net" &&
      host !== "video.bunnycdn.com"
    ) {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    const mode = parts[0];
    const libraryId = parts[1];
    const videoId = parts[2];

    if ((mode !== "embed" && mode !== "play") || !libraryId || !videoId) {
      return null;
    }
    return { libraryId, videoId };
  } catch {
    const match = src.match(/(?:player|iframe)\.mediadelivery\.net\/embed\/([^/]+)\/([^/?#]+)/);
    if (match) return { libraryId: match[1], videoId: match[2] };
    const matchPlay = src.match(/(?:player|iframe)\.mediadelivery\.net\/play\/([^/]+)\/([^/?#]+)/);
    if (matchPlay) return { libraryId: matchPlay[1], videoId: matchPlay[2] };
    return null;
  }
}

export function signBunnyEmbedUrl(videoUrl) {
  const parsed = parseBunnyVideoIdAndLibraryId(videoUrl);
  if (!parsed) {
    return {
      secureVideoUrl: videoUrl || "",
      videoProvider: "",
      videoAuthStatus: "not_bunny_embed"
    };
  }

  const { libraryId, videoId } = parsed;
  const normalizedVideoUrl = `https://player.mediadelivery.net/embed/${libraryId}/${videoId}`;
  const tokenKey = String(process.env.BUNNY_STREAM_TOKEN_KEY || "").trim();

  if (!tokenKey) {
    return {
      secureVideoUrl: "",
      videoProvider: "bunny_embed",
      videoAuthStatus: "missing_bunny_stream_token_key",
      normalizedVideoUrl
    };
  }

  const expires = Math.floor(Date.now() / 1000) + 600; // 10 minutes
  const token = crypto
    .createHash("sha256")
    .update(`${tokenKey}${videoId}${expires}`)
    .digest("hex");

  return {
    secureVideoUrl: `${normalizedVideoUrl}?token=${token}&expires=${expires}`,
    videoProvider: "bunny_embed",
    videoAuthStatus: "signed",
    normalizedVideoUrl,
    secureVideoExpiresAt: expires
  };
}

export function signMediaUrls(rawMediaUrlsStr) {
  const raw = rawMediaUrlsStr || "";
  if (!raw) return "";

  const tokenKey = String(process.env.BUNNY_STREAM_TOKEN_KEY || "").trim();

  return raw.split("\n").map(line => {
    const trimmed = line.trim();
    if (!trimmed) return "";

    const firstPipe = trimmed.indexOf("|");
    if (firstPipe === -1) return line;
    const secondPipe = trimmed.indexOf("|", firstPipe + 1);
    if (secondPipe === -1) return line;

    const type = trimmed.slice(0, firstPipe).trim();
    const title = trimmed.slice(firstPipe + 1, secondPipe).trim();
    const rawUrl = trimmed.slice(secondPipe + 1).trim();
    const url = extractIframeSrc(rawUrl).replace(/&amp;/g, "&").trim();

    if (type === "video") {
      if (
        url.includes("drive.google.com/file/d/") ||
        /drive\.google\.com\/open\?id=/.test(url) ||
        /drive\.google\.com\/uc\?id=/.test(url)
      ) {
        let fileId = "";
        let match = url.match(/drive\.google\.com\/file\/d\/([^/?#]+)/);
        if (match) fileId = match[1];
        else {
          match = url.match(/[?&]id=([^&#]+)/);
          if (match) fileId = match[1];
        }
        const previewUrl = fileId ? `https://drive.google.com/file/d/${fileId}/preview` : url;
        return `${type}|${title}|${previewUrl}`;
      }

      const parsed = parseBunnyVideoIdAndLibraryId(url);
      if (parsed) {
        const { libraryId, videoId } = parsed;
        if (url.includes("token=") && url.includes("expires=")) {
          return `${type}|${title}|${url}`;
        }
        if (!tokenKey) {
          return `video|${title}|error:Thiếu BUNNY_STREAM_TOKEN_KEY nên không ký được media`;
        }

        let queryParams = "";
        try {
          const urlObj = new URL(url);
          urlObj.searchParams.delete("token");
          urlObj.searchParams.delete("expires");
          const search = urlObj.search;
          if (search) queryParams = search.startsWith("?") ? search : "?" + search;
        } catch {
          const qIdx = url.indexOf("?");
          if (qIdx !== -1) {
            const searchParams = new URLSearchParams(url.slice(qIdx));
            searchParams.delete("token");
            searchParams.delete("expires");
            const searchStr = searchParams.toString();
            if (searchStr) queryParams = "?" + searchStr;
          }
        }

        const expires = Math.floor(Date.now() / 1000) + 600;
        const token = crypto
          .createHash("sha256")
          .update(`${tokenKey}${videoId}${expires}`)
          .digest("hex");

        const normalizedVideoUrl = `https://player.mediadelivery.net/embed/${libraryId}/${videoId}`;
        let secureUrl = `${normalizedVideoUrl}?token=${token}&expires=${expires}`;
        if (queryParams) {
          secureUrl = `${normalizedVideoUrl}${queryParams}&token=${token}&expires=${expires}`;
        }
        return `${type}|${title}|${secureUrl}`;
      }
    }
    return `${type}|${title}|${url}`;
  }).filter(Boolean).join("\n");
}

// Auto Enroll Logic when orders are approved
export async function autoEnroll(supabase, { email, courseSlug, name, phone, orderId }) {
  if (!email || !courseSlug) return;
  const cleanEmail = normalizeEmail(email);

  try {
    let studentId;
    const { data: student, error: studentError } = await supabase
      .from("students")
      .select("id")
      .eq("email", cleanEmail)
      .maybeSingle();

    if (studentError) {
      console.error("Error checking student in autoEnroll:", studentError);
    }

    if (student) {
      studentId = student.id;
      await supabase
        .from("students")
        .update({
          full_name: name || undefined,
          phone: phone || undefined,
          updated_at: new Date().toISOString()
        })
        .eq("id", studentId);
    } else {
      const { data: newStudent, error: insertError } = await supabase
        .from("students")
        .insert({
          email: cleanEmail,
          full_name: name || null,
          phone: phone || null,
          status: "active",
          updated_at: new Date().toISOString()
        })
        .select("id")
        .single();

      if (insertError) {
        console.error("Error inserting student in autoEnroll:", insertError);
        return;
      }
      studentId = newStudent.id;
    }

    const { data: course, error: courseError } = await supabase
      .from("courses")
      .select("id")
      .eq("slug", courseSlug)
      .maybeSingle();

    const courseId = course?.id || null;

    const { error: enrollError } = await supabase
      .from("student_enrollments")
      .upsert({
        student_id: studentId,
        course_id: courseId,
        course_slug: courseSlug,
        email: cleanEmail,
        status: "active",
        source_order_id: orderId || null,
        updated_at: new Date().toISOString()
      }, {
        onConflict: "email,course_slug"
      });

    if (enrollError) {
      console.error("Error upserting enrollment in autoEnroll:", enrollError);
    } else {
      console.log(`AutoEnroll success: Enrolled ${cleanEmail} to ${courseSlug}`);
    }
  } catch (err) {
    console.error("Unexpected error in autoEnroll:", err);
  }
}

export function getDriveClientWithToken(accessToken) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.drive({ version: "v3", auth });
}

export function getDocsClientWithToken(accessToken) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.docs({ version: "v1", auth });
}
