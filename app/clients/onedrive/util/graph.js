const fs = require("fs-extra");
const nodeFs = require("fs");
const fetch = require("node-fetch");
const { pipeline } = require("stream");
const { promisify } = require("util");
const { dirname } = require("path");
const crypto = require("crypto");
const getAccessToken = require("./getAccessToken");
const {
  GRAPH_URL,
  SIMPLE_UPLOAD_MAX_BYTES,
  UPLOAD_CHUNK_BYTES,
} = require("./constants");

const pipe = promisify(pipeline);

const MAX_ATTEMPTS = 5;
const RETRYABLE = { 429: true, 502: true, 503: true, 504: true };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Microsoft Graph throttles with 429 and a Retry-After header (seconds).
function retryDelay(res, attempt) {
  const header = parseInt(res.headers.get("retry-after"), 10);

  if (!isNaN(header)) return Math.min(header, 60) * 1000;

  return Math.min(500 * Math.pow(2, attempt), 8000);
}

async function toError(res) {
  let body = {};

  try {
    body = await res.json();
  } catch (e) {}

  const detail = body.error || {};
  const err = new Error(
    "OneDrive request failed (" +
      res.status +
      "): " +
      (detail.message || detail.code || res.statusText)
  );

  err.status = res.status;
  // Graph error code, e.g. "itemNotFound" or "quotaLimitReached"
  err.code = detail.code;

  return err;
}

// Sends a request, retrying throttling and transient gateway errors.
// `options.body` must be a string or Buffer so it can be re-sent.
async function send(url, options) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, options);

    if (res.ok) return res;

    if (RETRYABLE[res.status] && attempt < MAX_ATTEMPTS - 1) {
      await sleep(retryDelay(res, attempt));
      continue;
    }

    throw await toError(res);
  }
}

// A Graph call authenticated as the blog's OneDrive account. `path` is
// relative to the Graph root unless it is already an absolute URL (as
// with the @odata.nextLink of a paged response).
async function call(blogID, method, path, options) {
  options = options || {};

  const token = await getAccessToken(blogID);
  const headers = Object.assign({ Authorization: "Bearer " + token }, options.headers);
  let body = options.body;

  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  }

  return send(path.startsWith("http") ? path : GRAPH_URL + path, {
    method,
    headers,
    body,
  });
}

async function json(blogID, method, path, options) {
  const res = await call(blogID, method, path, options);

  return res.status === 204 ? null : res.json();
}

// Paths in a Graph URL are relative to a folder item: `/me/drive/items/
// {id}:/some/path:`. Encode each segment; keep the separators.
function encodePath(path) {
  return (
    "/" +
    path
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/")
  );
}

function itemPath(folderId, path) {
  return "/me/drive/items/" + folderId + ":" + encodePath(path) + ":";
}

// The blog's folders live inside the app folder (Apps/<app name>), which
// Graph creates on first access.
function getAppRoot(blogID) {
  return json(blogID, "GET", "/me/drive/special/approot?$select=id,name");
}

function getItem(blogID, itemId) {
  return json(
    blogID,
    "GET",
    "/me/drive/items/" + encodeURIComponent(itemId) + "?$select=id,name,folder,deleted"
  );
}

// "rename" means a second blog with the same title gets "Title 1"
// rather than sharing (and overwriting) the first blog's folder.
function createFolder(blogID, parentId, name) {
  return json(blogID, "POST", "/me/drive/items/" + parentId + "/children", {
    json: {
      name,
      folder: {},
      "@microsoft.graph.conflictBehavior": "rename",
    },
  });
}

function normalizeItem(item) {
  const hashes = (item.file && item.file.hashes) || {};

  return {
    id: item.id,
    name: item.name,
    is_directory: !!item.folder,
    size: item.size,
    sha1: hashes.sha1Hash,
    modified: item.lastModifiedDateTime,
  };
}

// Lists the children of `dir` (relative to the blog folder), following
// paging links.
async function listChildren(blogID, folderId, dir) {
  const path =
    !dir || dir === "/"
      ? "/me/drive/items/" + folderId + "/children"
      : itemPath(folderId, dir) + "/children";

  let url = path + "?$top=200&$select=id,name,size,folder,file,lastModifiedDateTime";
  let items = [];

  while (url) {
    const page = await json(blogID, "GET", url);

    items = items.concat(page.value.map(normalizeItem));
    url = page["@odata.nextLink"];
  }

  return items;
}

function mkdir(blogID, folderId, dir) {
  const parent = dirname(dir);
  const name = dir.split("/").filter(Boolean).pop();
  const url =
    parent === "/" || parent === "."
      ? "/me/drive/items/" + folderId + "/children"
      : itemPath(folderId, parent) + "/children";

  return json(blogID, "POST", url, {
    json: {
      name,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    },
  });
}

async function deleteItem(blogID, folderId, path) {
  try {
    await call(blogID, "DELETE", itemPath(folderId, path));
  } catch (err) {
    // Already gone
    if (err.status !== 404) throw err;
  }
}

// Uploads a local file to `path` inside the blog folder, replacing any
// existing file and creating missing parent folders.
async function upload(blogID, folderId, path, source) {
  const { size } = await fs.stat(source);

  if (size <= SIMPLE_UPLOAD_MAX_BYTES) {
    await call(
      blogID,
      "PUT",
      itemPath(folderId, path) + "/content?@microsoft.graph.conflictBehavior=replace",
      {
        headers: { "Content-Type": "application/octet-stream" },
        body: await fs.readFile(source),
      }
    );
    return;
  }

  const session = await json(
    blogID,
    "POST",
    itemPath(folderId, path) + "/createUploadSession",
    { json: { item: { "@microsoft.graph.conflictBehavior": "replace" } } }
  );

  const handle = await nodeFs.promises.open(source, "r");

  try {
    for (let start = 0; start < size; start += UPLOAD_CHUNK_BYTES) {
      const length = Math.min(UPLOAD_CHUNK_BYTES, size - start);
      const chunk = Buffer.alloc(length);

      await handle.read(chunk, 0, length, start);

      // The upload URL is pre-authenticated: don't send our token to it.
      await send(session.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(length),
          "Content-Range":
            "bytes " + start + "-" + (start + length - 1) + "/" + size,
        },
        body: chunk,
      });
    }
  } finally {
    await handle.close();
  }
}

// Downloads an item by ID to `destination`, via a temporary file so a
// failed transfer never leaves a truncated file in the blog folder.
async function download(blogID, item, destination) {
  const res = await call(
    blogID,
    "GET",
    "/me/drive/items/" + encodeURIComponent(item.id) + "/content"
  );

  const temporary = destination + "." + crypto.randomBytes(4).toString("hex") + ".tmp";

  await fs.ensureDir(dirname(destination));

  try {
    await pipe(res.body, nodeFs.createWriteStream(temporary));

    if (item.modified) {
      const mtime = new Date(item.modified);
      await fs.utimes(temporary, mtime, mtime);
    }

    await fs.move(temporary, destination, { overwrite: true });
  } catch (err) {
    await fs.remove(temporary);
    throw err;
  }
}

module.exports = {
  getAppRoot,
  getItem,
  createFolder,
  listChildren,
  mkdir,
  deleteItem,
  upload,
  download,
  encodePath,
};
