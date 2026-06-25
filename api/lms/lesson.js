import { supabase } from "../../utils/supabase.js";
import {
  verifyStudentSession,
  parseCookies,
  signBunnyEmbedUrl,
  signMediaUrls,
  normalizeEmail
} from "../../utils/lms.js";
import { google } from "googleapis";

const SESSION_COOKIE = "course_session_token";

function getGoogleAuth() {
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: privateKey
    },
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/documents.readonly"
    ]
  });
}

async function getDriveClient() {
  const auth = getGoogleAuth();
  return google.drive({ version: "v3", auth });
}

async function getDocsClient() {
  const auth = getGoogleAuth();
  return google.docs({ version: "v1", auth });
}

function getGoogleDocId(url) {
  const match = String(url || "").match(/docs\.google\.com\/document\/d\/([^/]+)/);
  return match ? match[1] : "";
}

function getGoogleDriveFileId(input) {
  const text = String(input || "").trim();
  const iframeMatch = text.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  const url = iframeMatch?.[1] ? iframeMatch[1].trim() : text;
  
  let match = url.match(/drive\.google\.com\/file\/d\/([^/?#]+)/);
  if (match) return match[1];
  match = url.match(/[?&]id=([^&#]+)/);
  if (match) return match[1];
  return "";
}

function googleDocBodyToText(document) {
  const lines = [];
  const content = document?.body?.content || [];
  content.forEach(block => {
    const paragraph = block.paragraph;
    if (!paragraph) return;
    const text = (paragraph.elements || [])
      .map(element => element.textRun?.content || "")
      .join("")
      .trimEnd();
    if (text.trim()) lines.push(text.trim());
  });
  return lines.join("\n").trim();
}

function htmlToPlainText(html) {
  const text = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  if (/^google drive|^sign in|quota exceeded|virus scan/i.test(text)) {
    return "";
  }
  return text;
}

function recipeTextUrl(recipeUrl) {
  const url = String(recipeUrl || "").trim();
  if (!url) return "";

  const docId = getGoogleDocId(url);
  if (docId) {
    return `https://docs.google.com/document/d/${docId}/export?format=txt`;
  }

  const fileId = getGoogleDriveFileId(url);
  if (fileId) {
    return `https://drive.google.com/uc?export=download&id=${fileId}`;
  }
  return url;
}

function recipePublicDownloadUrls(recipeUrl) {
  const url = String(recipeUrl || "").trim();
  const fileId = getGoogleDocId(url) || getGoogleDriveFileId(url);
  if (!fileId) return [url].filter(Boolean);

  return [
    `https://drive.usercontent.google.com/download?id=${fileId}&export=download`,
    `https://docs.google.com/uc?export=download&id=${fileId}`,
    `https://drive.google.com/uc?export=download&id=${fileId}`,
    recipeTextUrl(recipeUrl)
  ].filter(Boolean);
}

async function fetchRecipeTextFromGoogleApi(recipeUrl) {
  const docId = getGoogleDocId(recipeUrl);
  let fileId = docId || getGoogleDriveFileId(recipeUrl);
  if (!fileId) return "";

  const drive = await getDriveClient();
  let metadata;
  try {
    metadata = await drive.files.get({
      fileId,
      fields: "id,name,mimeType,shortcutDetails,capabilities",
      supportsAllDrives: true
    });
  } catch (err) {
    return "";
  }

  if (metadata.data.mimeType === "application/vnd.google-apps.shortcut" && metadata.data.shortcutDetails?.targetId) {
    fileId = metadata.data.shortcutDetails.targetId;
    try {
      metadata = await drive.files.get({
        fileId,
        fields: "id,name,mimeType,shortcutDetails,capabilities",
        supportsAllDrives: true
      });
    } catch {
      return "";
    }
  }

  const mimeType = metadata.data.mimeType || "";
  if (mimeType.startsWith("application/vnd.google-apps.")) {
    try {
      const result = await drive.files.export(
        { fileId, mimeType: "text/plain" },
        { responseType: "text" }
      );
      return String(result.data || "").trim();
    } catch (err) {
      if (mimeType === "application/vnd.google-apps.document") {
        const docs = await getDocsClient();
        const result = await docs.documents.get({ documentId: fileId });
        return googleDocBodyToText(result.data);
      }
      throw err;
    }
  }

  if (docId) {
    const docs = await getDocsClient();
    const result = await docs.documents.get({ documentId: docId });
    return googleDocBodyToText(result.data);
  }

  const result = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true, acknowledgeAbuse: true },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(result.data || "").toString("utf8").trim();
}

async function fetchRecipeTextFromPublicUrl(recipeUrl) {
  const urls = recipePublicDownloadUrls(recipeUrl);
  if (!urls.length) return "";

  let lastError = null;
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      if (!response.ok) throw new Error(`Status ${response.status}`);
      const contentType = response.headers.get("content-type") || "";
      const text = await response.text();

      if (contentType.includes("text/html") && /<html[\s>]/i.test(text)) {
        const plainText = htmlToPlainText(text);
        if (plainText) return plainText;
        throw new Error("HTML page returned");
      }
      return text.trim();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("Public fetch failed");
}

async function fetchRecipeText(recipeUrl) {
  if (!recipeUrl) return "";
  try {
    const text = await fetchRecipeTextFromGoogleApi(recipeUrl);
    if (text) return text;
  } catch (err) {
    console.warn("[lesson] Google API recipe fetch failed, trying public fallback:", err.message);
  }
  try {
    return await fetchRecipeTextFromPublicUrl(recipeUrl);
  } catch (err) {
    console.error("[lesson] Public recipe fetch failed:", err.message);
    return "";
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const { id } = req.query || {};
  if (!id) {
    return res.status(400).json({ success: false, error: "Thiếu tham số ID bài học" });
  }

  try {
    // 1. Fetch student session from cookies
    const cookies = parseCookies(req);
    const sToken = cookies[SESSION_COOKIE];
    let email = null;

    if (sToken) {
      const decoded = verifyStudentSession(sToken);
      if (decoded && decoded.email) {
        email = decoded.email;
      }
    }

    if (!email) {
      return res.status(401).json({
        success: false,
        error: "Vui lòng đăng nhập để truy cập bài học",
        authError: "missing_login_session"
      });
    }

    // 2. Fetch lesson record
    const { data: lesson, error: fetchError } = await supabase
      .from("lessons")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!lesson) {
      return res.status(404).json({ success: false, error: "Không tìm thấy bài học" });
    }

    // 3. Verify student enrollment for the course that this lesson belongs to
    const { data: enrollment, error: enrollError } = await supabase
      .from("student_enrollments")
      .select("id")
      .eq("email", email)
      .eq("course_slug", lesson.course_slug)
      .eq("status", "active")
      .maybeSingle();

    if (enrollError) throw enrollError;
    if (!enrollment) {
      return res.status(403).json({
        success: false,
        error: "Bạn không có quyền xem bài học của khóa học này.",
        email,
        course: lesson.course_slug
      });
    }

    // 4. Secure Video URL & Media URLs
    const securedVideo = signBunnyEmbedUrl(lesson.video_url || "");
    const securedMedia = signMediaUrls(lesson.media_urls || "");

    // 5. Fetch recipe text
    const recipeText = await fetchRecipeText(lesson.recipe_url);

    // Formatted lesson output
    const formattedLesson = {
      id: lesson.id,
      course: lesson.course_slug,
      lesson: lesson.lesson_no,
      title: lesson.title,
      description: lesson.description || "",
      duration: lesson.duration_text || "",
      level: lesson.level || "",
      thumbnailUrl: lesson.thumbnail_url || "",
      videoUrl: lesson.video_url || "",
      recipeUrl: lesson.recipe_url || "",
      mediaUrls: securedMedia,
      views: lesson.views || 0,
      status: lesson.status || "active",
      recipeText,
      ...securedVideo
    };

    return res.status(200).json({
      success: true,
      email,
      lesson: formattedLesson
    });

  } catch (err) {
    console.error("[api/lms/lesson] Error:", err);
    return res.status(500).json({
      success: false,
      error: "Lỗi hệ thống khi tải bài học",
      detail: err.message
    });
  }
}
