const { join, extname } = require("path");
const { URL } = require("url");
const crypto = require("crypto");
// The favicon URL comes from a <link rel="icon"> on an arbitrary remote page,
// so it is user-influenced and must be fetched through the airlock proxy -
// see remote.js. This path previously did a direct node-fetch, bypassing the
// airlock entirely.
const { fetch } = require("helper/airlock");
const fs = require("fs-extra");

const config = require("config");

const {
  ICON_DIRECTORY,
  REQUEST_TIMEOUT,
  MAX_ICON_BYTES,
} = require("./constants");
const { readLimitedBody } = require("./body");

async function ensureIcon(metadata, blogID) {
  if (!blogID) {
    // No blog to cache into - omit the favicon rather than publish the raw
    // third-party URL (a tracking beacon for every reader).
    metadata.icon = "";
    metadata.iconPath = "";
    return;
  }

  const remoteIcon = metadata.remoteIcon;

  if (!remoteIcon) {
    await cleanupIcon(metadata.iconPath, blogID);
    metadata.icon = "";
    metadata.iconPath = "";
    return;
  }

  if (metadata.iconPath && (await iconExists(metadata.iconPath, blogID))) {
    metadata.icon = buildPublicIconPath(metadata.iconPath, blogID);
    return;
  }

  await cleanupIcon(metadata.iconPath, blogID);

  const storedPath = await fetchAndStoreIcon(remoteIcon, blogID);
  if (!storedPath) {
    // Proxy/caching failed - drop the favicon instead of pointing readers'
    // browsers straight at the remote URL (which the airlock may have
    // rejected, or which the page serves only to real visitors).
    metadata.icon = "";
    metadata.iconPath = "";
    return;
  }

  metadata.iconPath = storedPath;
  metadata.icon = buildPublicIconPath(storedPath, blogID);
}

function buildPublicIconPath(path, blogID) {
  if (!path) return "";
  return `${config.cdn.origin}/${blogID}/${path}`;
}

async function iconExists(path, blogID) {
  if (!path) return false;

  const absolute = join(config.blog_static_files_dir, blogID, path);
  return fs.pathExists(absolute);
}

async function cleanupIcon(path, blogID) {
  if (!path) return;

  const absolute = join(config.blog_static_files_dir, blogID, path);
  await fs.remove(absolute).catch(() => {});
}

async function fetchAndStoreIcon(remoteIcon, blogID) {
  try {
    const response = await fetch(remoteIcon, {
      airlockLabel: "linkCards/icon",
      redirect: "follow",
      timeout: REQUEST_TIMEOUT,
      headers: {
        "user-agent": "Blot Link Cards (+https://blot.im)",
        accept:
          "image/avif,image/webp,image/apng,image/svg+xml,image/*;q=0.8",
      },
    });

    if (!response.ok) return null;

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const extension = determineExtension(contentType, remoteIcon);
    if (!extension) return null;

    const buffer = await readLimitedBody(response, MAX_ICON_BYTES);
    if (!buffer || !buffer.length) return null;

    const fileName = `${createIconBaseName(remoteIcon)}.${extension}`;
    const directory = join(
      config.blog_static_files_dir,
      blogID,
      ICON_DIRECTORY
    );

    await fs.ensureDir(directory);

    const absolute = join(directory, fileName);
    await fs.writeFile(absolute, buffer);

    return `${ICON_DIRECTORY}/${fileName}`;
  } catch (err) {
    return null;
  }
}

function createIconBaseName(remoteIcon) {
  return crypto.createHash("sha1").update(remoteIcon).digest("hex");
}

function determineExtension(contentType, remoteIcon) {
  if (contentType.includes("svg")) return "svg";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("avif")) return "avif";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("bmp")) return "bmp";
  if (
    contentType.includes("x-icon") ||
    contentType.includes("ico") ||
    contentType.includes("vnd.microsoft.icon")
  ) {
    return "ico";
  }

  const ext = normalizeExtensionFromURL(remoteIcon);
  if (ext) return ext;

  return "";
}

function normalizeExtensionFromURL(remoteIcon) {
  try {
    const url = new URL(remoteIcon);
    const pathname = url.pathname || "";
    const ext = extname(pathname).toLowerCase();

    switch (ext) {
      case ".svg":
        return "svg";
      case ".png":
        return "png";
      case ".jpg":
      case ".jpeg":
        return "jpg";
      case ".webp":
        return "webp";
      case ".avif":
        return "avif";
      case ".gif":
        return "gif";
      case ".bmp":
        return "bmp";
      case ".ico":
        return "ico";
      default:
        return "";
    }
  } catch (err) {
    return "";
  }
}

module.exports = {
  ensureIcon,
  fetchAndStoreIcon,
  determineExtension,
  normalizeExtensionFromURL,
};
