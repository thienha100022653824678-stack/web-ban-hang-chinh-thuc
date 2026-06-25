import { supabase } from "../../utils/supabase.js";
import {
  normalizeEmail,
  verifyStudentSession,
  createStudentSession,
  verifyGoogleIdToken,
  parseCookies,
  cookieOptions,
  signBunnyEmbedUrl,
  signMediaUrls
} from "../../utils/lms.js";
import { google } from "googleapis";
import crypto from "crypto";

const SESSION_COOKIE = "course_session_token";
const API_VERSION = "premium-bunny-stream-v1";

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
    console.warn("[course-data] Error fetching drive metadata:", err.message);
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
    } catch (err) {
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
    console.warn("[course-data] Google API recipe fetch failed, trying public fallback:", err.message);
  }
  try {
    return await fetchRecipeTextFromPublicUrl(recipeUrl);
  } catch (err) {
    console.error("[course-data] Public recipe fetch failed:", err.message);
    return "";
  }
}

async function attachRecipeText(lesson) {
  if (!lesson.recipe_url) {
    return { ...lesson, recipeText: "" };
  }
  const text = await fetchRecipeText(lesson.recipe_url);
  return {
    ...lesson,
    recipeText: text
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ allowed: false, error: "Method not allowed" });
  }

  try {
    const { credential, sessionToken, course } = req.body || {};
    const courseSlug = String(course || "").trim();
    const cookies = parseCookies(req);
    const sToken = sessionToken || cookies[SESSION_COOKIE];

    let email = null;
    let fromSession = false;

    if (sToken) {
      const decoded = verifyStudentSession(sToken);
      if (decoded && decoded.email) {
        email = decoded.email;
        fromSession = true;
      }
    }

    if (!email && credential) {
      email = await verifyGoogleIdToken(credential);
    }

    if (!email) {
      return res.status(401).json({
        allowed: false,
        error: "Missing or expired login session",
        authError: "missing_login_session"
      });
    }

    // 1. Fetch all active course enrollments for this student
    const { data: enrollments, error: enrollError } = await supabase
      .from("student_enrollments")
      .select("course_slug")
      .eq("email", email)
      .eq("status", "active");

    if (enrollError) throw enrollError;

    const allowedCourses = (enrollments || []).map(e => e.course_slug);

    if (allowedCourses.length === 0) {
      return res.status(403).json({
        allowed: false,
        email,
        error: "Student has no active course enrollments"
      });
    }

    // If no course is specified in request, default to the first allowed course
    const activeCourseSlug = courseSlug && allowedCourses.includes(courseSlug)
      ? courseSlug
      : allowedCourses[0];

    // Check if the student is enrolled in the target course
    if (!allowedCourses.includes(activeCourseSlug)) {
      return res.status(403).json({
        allowed: false,
        email,
        error: `Tài khoản ${email} chưa kích hoạt khóa học này.`,
        allowedCourses
      });
    }

    // 2. Load Config from site_config table
    const { data: configRows } = await supabase.from("site_config").select("key, value");
    const courseInfo = {};
    if (configRows) {
      configRows.forEach(row => {
        const valObj = row.value;
        const val = (valObj && typeof valObj === "object" && valObj.val !== undefined) ? valObj.val : valObj;
        courseInfo[row.key] = val;
      });
    }

    // Fallback headers default values if site_config is empty
    if (!courseInfo.title) courseInfo.title = "Culinary Academy";

    // 3. Load Lessons from Supabase
    const { data: lessonsRows, error: lessonsError } = await supabase
      .from("lessons")
      .select("*")
      .eq("course_slug", activeCourseSlug)
      .neq("status", "hidden")
      .order("lesson_no", { ascending: true });

    if (lessonsError) throw lessonsError;

    // Map columns from Supabase schema to match the legacy frontend expectation
    let lessons = (lessonsRows || []).map(l => {
      const securedVideo = signBunnyEmbedUrl(l.video_url || "");
      const securedMedia = signMediaUrls(l.media_urls || "");

      return {
        id: l.id,
        course: l.course_slug,
        lesson: l.lesson_no,
        title: l.title,
        description: l.description || "",
        duration: l.duration_text || "",
        level: l.level || "",
        thumbnailUrl: l.thumbnail_url || "",
        videoUrl: l.video_url || "",
        recipeUrl: l.recipe_url || "",
        mediaUrls: securedMedia,
        views: l.views || 0,
        status: l.status || "active",
        ...securedVideo
      };
    });

    // Fetch Google Docs recipe contents
    lessons = await Promise.all(lessons.map(attachRecipeText));

    // Generate new student session token
    const newSession = createStudentSession(email);
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${encodeURIComponent(newSession.token)}; ${cookieOptions(newSession.expiresAt - Date.now())}`
    );

    return res.status(200).json({
      allowed: true,
      apiVersion: API_VERSION,
      email,
      course: activeCourseSlug,
      allowedCourses,
      courseInfo,
      lessons,
      sessionToken: newSession.token,
      sessionExpiresAt: newSession.expiresAt
    });

  } catch (err) {
    console.error("[course-data] Unexpected error:", err);
    return res.status(500).json({
      allowed: false,
      error: "Server error",
      detail: err.message
    });
  }
}
