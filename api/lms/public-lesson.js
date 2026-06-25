import { supabase } from "../../utils/supabase.js";
import { google } from "googleapis";

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
    console.warn("[public-lesson] Google API recipe fetch failed, trying public fallback:", err.message);
  }
  try {
    return await fetchRecipeTextFromPublicUrl(recipeUrl);
  } catch (err) {
    console.error("[public-lesson] Public recipe fetch failed:", err.message);
    return "";
  }
}

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

  const { course, lesson } = req.body || {};
  const courseSlug = String(course || "").trim();
  const lessonNum = parseInt(lesson, 10);

  if (!courseSlug || isNaN(lessonNum)) {
    return res.status(400).json({ success: false, error: "Thiếu thông tin course hoặc lesson" });
  }

  try {
    // 1. Get lesson and increment views count
    const { data: lessonRecord, error: fetchError } = await supabase
      .from("lessons")
      .select("*")
      .eq("course_slug", courseSlug)
      .eq("lesson_no", lessonNum)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!lessonRecord) {
      return res.status(404).json({
        success: false,
        error: `Không tìm thấy bài học ${lessonNum} của khóa học ${courseSlug}`
      });
    }

    const currentViews = lessonRecord.views || 0;
    const newViews = currentViews + 1;

    // Increment in Supabase
    const { data: updatedLesson } = await supabase
      .from("lessons")
      .update({ views: newViews })
      .eq("id", lessonRecord.id)
      .select()
      .single();

    const lessonData = updatedLesson || { ...lessonRecord, views: newViews };

    // 2. Fetch recipe text
    const recipeText = await fetchRecipeText(lessonData.recipe_url);

    // Map output columns to match legacy index/photo expectation
    const formattedLesson = {
      id: lessonData.id,
      course: lessonData.course_slug,
      lesson: lessonData.lesson_no,
      title: lessonData.title,
      description: lessonData.description || "",
      duration: lessonData.duration_text || "",
      level: lessonData.level || "",
      thumbnailUrl: lessonData.thumbnail_url || "",
      videoUrl: lessonData.video_url || "",
      recipeUrl: lessonData.recipe_url || "",
      mediaUrls: lessonData.media_urls || "",
      views: lessonData.views || 0,
      status: lessonData.status || "active",
      recipeText
    };

    return res.status(200).json({
      success: true,
      lesson: formattedLesson
    });

  } catch (err) {
    console.error("[public-lesson] Error:", err);
    return res.status(500).json({
      success: false,
      error: "Lỗi hệ thống khi tải bài học",
      detail: err.message
    });
  }
}
