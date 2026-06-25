import { Readable } from "stream";
import { getAdminFromRequest, getDriveClientWithToken } from "../../utils/lms.js";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "4.5mb",
    },
  },
};

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
    const adminSession = getAdminFromRequest(req);
    if (!adminSession) {
      return res.status(401).json({ success: false, error: "Chưa đăng nhập admin" });
    }

    const { fileData, fileName, mimeType, course, lesson, title, accessToken } = req.body || {};

    if (!accessToken || typeof accessToken !== "string" || !accessToken.trim()) {
      return res.status(200).json({
        success: false,
        needsOAuth: true,
        error: "Chưa kết nối Google Drive"
      });
    }

    if (!fileData || typeof fileData !== "string") {
      return res.status(400).json({ success: false, error: "Thiếu dữ liệu ảnh (fileData)" });
    }

    let cleanBase64 = fileData;
    let cleanMimeType = mimeType || "image/jpeg";

    if (fileData.includes(";base64,")) {
      const parts = fileData.split(";base64,");
      const mimeMatch = parts[0].match(/data:([^;]+)/);
      if (mimeMatch) cleanMimeType = mimeMatch[1];
      cleanBase64 = parts[1];
    }

    let buffer;
    try {
      buffer = Buffer.from(cleanBase64, "base64");
    } catch {
      return res.status(400).json({ success: false, error: "Dữ liệu ảnh không hợp lệ" });
    }

    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      return res.status(400).json({
        success: false,
        error: `Ảnh quá lớn (${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB). Tối đa 4 MB.`
      });
    }

    const ext = cleanMimeType.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
    let finalFileName = fileName || `image_${Date.now()}.${ext}`;
    if (course && lesson && title) {
      finalFileName = `${course} - ${lesson} - ${title}.${ext}`.replace(/[/\\?%*:|"<>]/g, "-");
    }

    const drive = getDriveClientWithToken(accessToken);
    const folderId = (process.env.GOOGLE_DRIVE_IMAGE_FOLDER_ID || "").trim();

    const fileMetadata = { name: finalFileName };
    if (folderId) fileMetadata.parents = [folderId];

    let driveFile;
    try {
      driveFile = await drive.files.create({
        requestBody: fileMetadata,
        media: { mimeType: cleanMimeType, body: Readable.from(buffer) },
        fields: "id, webViewLink, webContentLink",
        supportsAllDrives: true,
      });
    } catch (err) {
      console.error("[admin-upload-image] Drive API error:", err);
      return res.status(500).json({
        success: false,
        error: "Upload ảnh lên Google Drive thất bại",
        message: err.message
      });
    }

    const fileId = driveFile.data.id;
    if (!fileId) {
      return res.status(500).json({ success: false, error: "Google API không trả về ID file" });
    }

    // Share publicly
    try {
      await drive.permissions.create({
        fileId,
        requestBody: { role: "reader", type: "anyone" },
        supportsAllDrives: true,
      });
    } catch (err) {
      console.warn("[admin-upload-image] Could not share file publicly:", err.message);
    }

    const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
    const webViewLink = driveFile.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;

    return res.status(200).json({
      success: true,
      fileId,
      directUrl,
      webViewLink,
    });
  } catch (err) {
    console.error("[admin-upload-image] Unexpected error:", err);
    return res.status(500).json({
      success: false,
      error: "Lỗi server khi upload ảnh",
      message: err.message,
    });
  }
}
