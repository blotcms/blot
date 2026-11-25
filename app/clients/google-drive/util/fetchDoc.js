// Fetches a Google Doc through the Docs API and writes its JSON to the blog
// folder as the .gdoc file, for build/converters/gdoc/json.js to render
// (#2975). Faster than the zip export (one docs.get, 0.1-0.3s, against an
// export and an unzip, 0.5-1.5s) and it gives the largest images Google keeps
// (2047px where the zip gave 1999px, 24 Nov 2026).
//
// Images: each inline image is keyed by its object id and everything about
// it but the short-lived contentUri (size, crop, alt text). One already held
// (database/docImages.js) is reused with no request at all, so a text edit
// makes no request to Google or to the bucket for images. A new or changed
// one is fetched from its contentUri (no auth needed), named by a hash of its
// bytes and written to the Doc's _assets directory, several at a time. Images
// the Doc no longer uses are deleted.
//
// Resolves to { updated: true, revision }, { updated: false } when the post
// is already built at this revision, or to null when the Doc holds something the
// Docs API can't give (a drawing, a positioned image, an equation), for the
// caller to use the zip export instead.
const crypto = require("crypto");
const mime = require("mime-types");
const folder = require("storage/folder");
const { throwIfAborted } = require("storage/folder/guard");
const assets = require("storage/assets");
const hash = require("helper/hash");
const clfdate = require("helper/clfdate");
const database = require("../database");
const docImages = require("../database/docImages");
const localState = require("./localState");
const createDocsClient = require("../serviceAccount/createDocsClient");

const IMAGE_CONCURRENCY = 4;
const IMAGE_TIMEOUT_MS = 30 * 1000;

// Formatting the renderer doesn't use, dropped so the stored file is small
const DROP = new Set([
  "startIndex",
  "endIndex",
  "foregroundColor",
  "backgroundColor",
  "fontSize",
  "embeddedObjectBorder",
  "marginTop",
  "marginBottom",
  "marginLeft",
  "marginRight",
  "shading",
  "borderBetween",
  "borderTop",
  "borderBottom",
  "borderLeft",
  "borderRight",
  "suggestedTextStyleChanges",
  "suggestedParagraphStyleChanges",
  "suggestedInsertionIds",
  "suggestedDeletionIds",
  "documentStyle",
  // The .gdoc file is served from the folder as it is: nothing that leads
  // back to the Doc (its id, an image's source link) or that the post
  // doesn't show (headers, footers)
  "documentId",
  "sourceUri",
  "headers",
  "footers",
]);

function trim(value) {
  if (Array.isArray(value)) return value.map(trim);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value))
    if (!DROP.has(k)) out[k] = trim(v);
  return out;
}

const tabsOf = (doc) => {
  const all = [];
  const walk = (tab) => {
    all.push(tab);
    (tab.childTabs || []).forEach(walk);
  };
  (doc.tabs || []).forEach(walk);
  return all;
};

// What only the zip export can give
function unsupported(doc) {
  for (const tab of tabsOf(doc)) {
    const dt = tab.documentTab || {};
    if (Object.keys(dt.positionedObjects || {}).length)
      return "positioned object";
    for (const object of Object.values(dt.inlineObjects || {})) {
      const embedded =
        (object.inlineObjectProperties || {}).embeddedObject || {};
      if (!embedded.imageProperties) return "drawing";
    }
    if (JSON.stringify(dt.body || {}).includes('"equation"')) return "equation";
  }
  return null;
}

const objectKey = (id, embedded) => {
  const { imageProperties, ...rest } = embedded;
  const { contentUri, ...image } = imageProperties || {};
  return (
    id +
    ":" +
    crypto
      .createHash("sha1")
      .update(JSON.stringify([rest, image]))
      .digest("hex")
      .slice(0, 12)
  );
};

async function fetchImage(uri) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    const response = await fetch(uri, { signal: controller.signal });
    if (!response.ok) throw new Error("Image fetch failed: " + response.status);
    const type = (response.headers.get("content-type") || "").split(";")[0];
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      ext: mime.extension(type) || "jpg",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function eachLimit(items, limit, fn) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
}

module.exports = async function fetchDoc(
  blogID,
  path,
  { id },
  { serviceAccountId, docs, acquireSlot, publish = (fn) => fn() } = {}
) {
  const started = Date.now();
  if (!serviceAccountId) {
    const account = await database.blog.get(blogID);
    serviceAccountId = account && account.serviceAccountId;
  }
  docs = docs || (await createDocsClient(serviceAccountId));

  // The same budget as the hot doc poller's polls
  if (acquireSlot) await acquireSlot(serviceAccountId);
  const { data } = await docs.documents.get({
    documentId: id,
    includeTabsContent: true,
    suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS",
  });
  const fetched = Date.now();

  const reason = unsupported(data);
  if (reason) {
    console.log(
      clfdate(),
      "Google Drive: Doc needs the zip export",
      blogID,
      path,
      reason
    );
    return null;
  }

  const assetDir = "_assets/" + hash(path);

  // Already built into the post at this revision (the hot doc poller got
  // here first, or this is the walk that runs once Drive's modifiedTime
  // catches up): nothing to write, so nothing to rebuild
  if (data.revisionId && (await isBuilt(blogID, id, path, data.revisionId))) {
    console.log(
      clfdate(),
      "Google Drive: Doc unchanged",
      blogID,
      path,
      `fetch_ms=${fetched - started}`
    );
    return { updated: false };
  }

  // Trusted only for the same directory, and while the Doc's file is still
  // in the folder: a rename moves the Doc to another directory, and a Doc
  // removed (and its images with it, sync/update/removeConvertedAssets) then
  // restored has to fetch its images again
  const record = await docImages.get(blogID, id);
  const held =
    record.dir === assetDir && (await folder.exists(blogID, path))
      ? record.images || {}
      : {};
  const now = {};
  const toFetch = [];

  for (const tab of tabsOf(data)) {
    for (const [objectId, object] of Object.entries(
      tab.documentTab.inlineObjects || {}
    )) {
      const embedded = object.inlineObjectProperties.embeddedObject;
      const keyed = objectKey(objectId, embedded);
      if (held[keyed]) now[keyed] = held[keyed];
      else toFetch.push({ keyed, embedded });
    }
  }

  // A disconnect seizes the folder lock (sync/seize.js): folder writes and
  // docImages then refuse, and nothing is fetched or written to the bucket
  // after that either. A fetch already in flight finishes, then stops here.
  const written = [];
  try {
    await eachLimit(toFetch, IMAGE_CONCURRENCY, async ({ keyed, embedded }) => {
      throwIfAborted();
      const { buffer, ext } = await fetchImage(
        embedded.imageProperties.contentUri
      );
      const file =
        crypto.createHash("sha1").update(buffer).digest("hex").slice(0, 16) +
        "." +
        ext;
      throwIfAborted();
      await publish(() => assets.write(blogID, assetDir + "/" + file, buffer));
      written.push(file);
      now[keyed] = file;
    });
  } catch (err) {
    // The caller falls back to the zip export: remove what this fetch wrote
    const kept = new Set(Object.values(held));
    for (const file of written)
      if (!kept.has(file))
        await assets.remove(blogID, assetDir + "/" + file).catch(() => {});
    throw err;
  }
  const imagesDone = Date.now();

  for (const tab of tabsOf(data)) {
    for (const [objectId, object] of Object.entries(
      tab.documentTab.inlineObjects || {}
    )) {
      const embedded = object.inlineObjectProperties.embeddedObject;
      const file = now[objectKey(objectId, embedded)];
      embedded.imageProperties = {
        ...embedded.imageProperties,
        contentUri: undefined,
        blotSrc: "/" + assetDir + "/" + file,
      };
    }
  }

  // Marked as Blot's, for the converter, now the Doc's id is dropped
  const stored = JSON.stringify({ blotDoc: 1, ...trim(data) });
  await publish(() => folder.write(blogID, path, stored));
  await publish(() =>
    docImages.set(blogID, id, { dir: assetDir, images: now })
  );

  // Images this Doc no longer uses. Only when its images changed, so a text
  // edit lists nothing.
  const gone = Object.values(held).filter(
    (file) => !Object.values(now).includes(file)
  );
  throwIfAborted();
  for (const file of new Set(gone))
    await publish(() =>
      assets.remove(blogID, assetDir + "/" + file).catch(() => {})
    );

  console.log(
    clfdate(),
    "Google Drive: fetched Doc",
    blogID,
    path,
    `images=${Object.keys(now).length}`,
    `new_images=${toFetch.length}`,
    `fetch_ms=${fetched - started}`,
    `images_ms=${imagesDone - fetched}`,
    `write_ms=${Date.now() - imagesDone}`,
    `bytes=${stored.length}`
  );

  // The caller records it with markBuilt once the post is built
  return { updated: true, revision: data.revisionId || null };
};

// Whether the post at path is built from this revision of the Doc, with the
// file Blot holds still the one it was built from (an upload from the
// dashboard can replace it)
async function isBuilt(blogID, fileId, path, revision) {
  const built = await docImages.getBuilt(blogID, fileId, path);
  if (!built || built.revision !== revision) return false;
  const { sha1 } = await localState.stateOf(blogID, path);
  return Boolean(sha1) && sha1 === built.sha1;
}

// For the caller once the post for a fetch's { revision } is built without
// an error: the next fetch of that revision can skip the write
async function markBuilt(blogID, fileId, path, revision) {
  if (!revision) return;
  const { sha1 } = await localState.stateOf(blogID, path);
  await docImages.setBuilt(blogID, fileId, { revision, path, sha1 });
}

module.exports.isBuilt = isBuilt;
module.exports.markBuilt = markBuilt;
module.exports.unsupported = unsupported;
module.exports.objectKey = objectKey;
module.exports.trim = trim;
