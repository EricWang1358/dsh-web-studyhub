import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { detectRasterImageMime } from "./study-image-policy.js";
import { MAX_FOCUS_IMAGES, MAX_FOCUS_IMAGE_BYTES } from "./focus-points.js";

export { MAX_FOCUS_IMAGES, MAX_FOCUS_IMAGE_BYTES };
const MAX_ENCODED_CHARS = Math.ceil(MAX_FOCUS_IMAGE_BYTES / 3) * 4;

const EXT_BY_MIME = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
});

function sanitizeStem(name, fallback) {
  const raw = typeof name === "string" ? name.replace(/\.[^.]+$/, "") : "";
  const cleaned = raw
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned || fallback;
}

function decodeRasterDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") throw new Error("请上传有效的图片文件（PNG、JPG、WebP 或 GIF）");
  const header = /^data:(image\/(?:png|jpeg|webp|gif));base64,/i.exec(dataUrl);
  if (!header) throw new Error("仅支持 PNG、JPG、WebP 或 GIF 格式的重点图片");
  const declaredMime = header[1].toLowerCase();
  const encoded = dataUrl.slice(header[0].length).replace(/\s+/g, "");
  if (!encoded || encoded.length > MAX_ENCODED_CHARS || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("图片数据损坏或超过单张 10 MB 上限");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_FOCUS_IMAGE_BYTES) {
    throw new Error("单张重点图片不能超过 10 MB");
  }
  const detectedMime = detectRasterImageMime(bytes.subarray(0, Math.min(bytes.length, 16)));
  if (!detectedMime || detectedMime !== declaredMime) {
    throw new Error("图片文件内容与格式不匹配，请重新截图或导出为 PNG / JPG");
  }
  return { bytes, mimeType: detectedMime, ext: EXT_BY_MIME[detectedMime] };
}

function assertInsideRoot(baseDir, targetPath) {
  const rootResolved = resolve(baseDir);
  const targetResolved = resolve(targetPath);
  if (targetResolved !== rootResolved && !targetResolved.startsWith(rootResolved + sep)) {
    throw new Error("Invalid focus intake staging path");
  }
  return targetResolved;
}

/**
 * Validate and stage 1..10 raster screenshots/photos into `<workspace>/studyhub-work/focus-intake/<batch>/`
 * so the main conversation (vision model OR text-only DeepSeek with local OCR/MinerU) can read them safely.
 */
export async function stageFocusImages(baseDir, args = {}) {
  if (typeof baseDir !== "string" || !baseDir.trim()) throw new Error("Workspace directory is unavailable");
  const items = Array.isArray(args.files) ? args.files : [];
  if (!items.length) throw new Error("请先添加至少一张重点图片");
  if (items.length > MAX_FOCUS_IMAGES) throw new Error(`一次最多放入 ${MAX_FOCUS_IMAGES} 张重点图片`);

  const decoded = items.map((item, index) => {
    const { bytes, mimeType, ext } = decodeRasterDataUrl(item?.dataUrl);
    const stem = sanitizeStem(item?.name, `focus-${index + 1}`);
    const filename = `${String(index + 1).padStart(2, "0")}-${stem}.${ext}`;
    return { originalName: String(item?.name || filename).slice(0, 120), filename, bytes, mimeType };
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const batchFolder = `${stamp}-${randomUUID().slice(0, 6)}`;
  const targetDir = assertInsideRoot(baseDir, join(baseDir, "studyhub-work", "focus-intake", batchFolder));
  await mkdir(targetDir, { recursive: true });

  const staged = [];
  for (const item of decoded) {
    const fullPath = assertInsideRoot(baseDir, join(targetDir, item.filename));
    await writeFile(fullPath, item.bytes);
    const relativePath = relative(resolve(baseDir), fullPath).replaceAll("\\", "/");
    staged.push({
      name: item.originalName,
      filename: item.filename,
      relativePath,
      mimeType: item.mimeType,
      bytes: item.bytes.length,
    });
  }
  return { folder: `studyhub-work/focus-intake/${batchFolder}`, files: staged };
}
