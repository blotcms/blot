const fs = require("fs-extra");
const pipeline = require("util").promisify(require("stream").pipeline);
const folder = require("storage/folder");
const localFile = require("./localFile");
const colors = require("colors/safe");
const { join, dirname, sep } = require("path");
const debug = require("debug")("blot:clients:google-drive:download");
const clfdate = require("helper/clfdate");
const tempDir = require("helper/tempDir")();
const guid = require("helper/guid");
const verifyContent = require("./verifyContent");
const assets = require("storage/assets");
const hash = require("helper/hash");
const cheerio = require("cheerio");
const removeComments = require("build/converters/gdoc/comments");
const sandbox = require("sandbox");
const hotDocPoller = require("../serviceAccount/hotDocPoller");
const database = require("../database");
const prefetch = require("./prefetch");

const isExportSizeLimitError = (err) => {
  // Try to parse err.message if it's a JSON string
  let errorData = null;

  if (typeof err.message === "string") {
    try {
      errorData = JSON.parse(err.message);
    } catch (e) {
      // Not JSON, that's fine
    }
  } else if (err.message && typeof err.message === "object") {
    errorData = err.message;
  }

  return (
    errorData?.error?.code === 403 &&
    errorData?.error?.message?.includes("too large to be exported")
  );
};

// How a download publishes into the blog folder. A caller running several
// downloads at once passes its own publish(fn), which runs fn when the folder
// is free to take another write; by default fn runs straight away.
const run = (fn) => fn();

// Whether Drive's modifiedTime is within the last half hour, or unknown
const HOT_WINDOW_MS = 30 * 60 * 1000;
const editedRecently = (modifiedTime) => {
  const at = Date.parse(modifiedTime);
  return !Number.isFinite(at) || Date.now() - at < HOT_WINDOW_MS;
};

const ensurePlaceholder = async (blogID, path, flag) => {
  // The caller (sync.js) records the remote modifiedTime in the client's
  // own database once this resolves, so Blot knows not to re-fetch this
  // placeholder every sync. We no longer need the local file's mtime to
  // carry that information.
  let stat;
  try {
    stat = await folder.stat(blogID, path);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (stat && stat.isDirectory) {
    throw new Error("Cannot make a placeholder over a directory: " + path);
  }
  if (!stat) return folder.writePlaceholder(blogID, path, flag);

  // An empty file written before placeholders were flagged: flag it, so it
  // isn't taken for a file which really is empty. A file with bytes (an
  // earlier export of a Doc which has since grown too large) is kept.
  if (stat.size === 0 && !stat.placeholder)
    await folder.setFlags(blogID, path, "sync", [flag]);
};

// storage/folder's stat of a file in the blog's folder, or null if there is
// no file there
const statOnBlot = async (blogID, path, options) => {
  try {
    const stat = await folder.stat(blogID, path, options);
    return stat.isDirectory ? null : stat;
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
};

// { checksum, sha1 } of the file at path in the blog's folder, if it has
// Drive's md5Checksum, or null. Reads the file (on S3, into the content
// cache) to hash it, and vouches for it only while the folder's index holds
// the same SHA-1, so a file changed while it was read is not vouched for.
// The pair is what the walk remembers (clients/util/remoteHashes.js).
const verifyOnBlot = async (blogID, path, md5Checksum) => {
  if (!md5Checksum) return null;
  const stat = await statOnBlot(blogID, path, { sha1: true });
  if (!stat) return null;
  const file = await localFile(blogID, path);
  const hashes = file ? await verifyContent(file, md5Checksum) : null;
  return hashes && stat.sha1 === hashes.sha1 ? hashes : null;
};

// After download() has published a file it verified in its tmp file: the
// pair, if the file now in the blog's folder holds those bytes. The SHA-1 is
// free from the index.
const verifyPublished = async (blogID, path, hashes) => {
  if (!hashes) return null;
  const stat = await statOnBlot(blogID, path, { sha1: true });
  return stat && stat.sha1 === hashes.sha1 ? hashes : null;
};

const streamToFile = (readStream, filePath) =>
  pipeline(readStream, fs.createWriteStream(filePath));

// A Google Doc exported as a zip: its HTML and images. Docs over 10mb can't be
// exported at all, so these are generous, and only there for a hostile zip.
const ZIP_LIMITS = {
  maxEntries: 2000,
  maxBytes: 50 * 1024 * 1024,
  maxRatio: 200,
};

// The zip is read in the sandbox (app/sandbox/jobs/unzip.js), which can't reach
// the disk: the files are written here, each inside extractDir
const extractZip = async (zipPath, extractDir) => {
  const { meta, outputs } = await sandbox.run("unzip", ZIP_LIMITS, {
    path: zipPath,
  });
  if (meta.error)
    throw new Error("Could not unzip export: " + meta.error.reason);

  await fs.ensureDir(extractDir);

  for (let i = 0; i < meta.files.length; i++) {
    const destPath = join(extractDir, meta.files[i]);
    if (!destPath.startsWith(extractDir + sep))
      throw new Error("Zip entry outside the export");
    await fs.ensureDir(dirname(destPath));
    await fs.writeFile(destPath, outputs[i]);
  }
};

const resolveHtmlAndImagesDir = async (extractDir) => {
  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  let workDir = extractDir;
  if (entries.length === 1 && entries[0].isDirectory()) {
    workDir = join(extractDir, entries[0].name);
  }
  const workEntries = await fs.readdir(workDir, { withFileTypes: true });
  const htmlEntry = workEntries.find(
    (e) => !e.isDirectory() && e.name.toLowerCase().endsWith(".html")
  );
  if (!htmlEntry) throw new Error("No HTML file found in zip");
  const htmlPath = join(workDir, htmlEntry.name);
  const imagesDirPath = join(workDir, "images");
  let imagesDir = null;
  try {
    const stat = await fs.stat(imagesDirPath);
    if (stat.isDirectory()) imagesDir = imagesDirPath;
  } catch (_) {}
  return { htmlPath, imagesDir };
};

const getDriveAuth = (drive) => {
  return drive?.context?._options?.auth || drive?._options?.auth || null;
};

const fetchZipExportStreamFromExportLink = async (drive, exportUrl) => {
  const auth = getDriveAuth(drive);

  if (!auth?.request) {
    throw new Error("Missing authenticated Drive request client");
  }

  // Call request as a method on auth so its internals (e.g. this.getClient()) work
  const response = await auth.request({
    url: exportUrl,
    method: "GET",
    responseType: "stream",
  });

  return response?.data;
};

const downloadGoogleDocAsZip = async ({
  drive,
  id,
  path,
  blogID,
  zipStream,
  publish = run,
}) => {
  const zipPath = join(tempDir, guid());
  const extractDir = join(tempDir, guid());
  // Each stage's time, logged once the Doc is published (#2975)
  const timings = {};
  let stageStart = Date.now();
  const stage = (name) => {
    timings[name] = Date.now() - stageStart;
    stageStart = Date.now();
  };
  let imageCount = 0;

  try {
    const stream =
      zipStream ||
      (
        await drive.files.export(
          {
            fileId: id,
            mimeType: "application/zip",
            supportsAllDrives: true,
          },
          { responseType: "stream" }
        )
      ).data;

    await streamToFile(stream, zipPath);
    stage("export_ms");
    await extractZip(zipPath, extractDir);
    stage("unzip_ms");
    const { htmlPath, imagesDir } = await resolveHtmlAndImagesDir(extractDir);
    const docHash = hash(path);
    const assetDir = "_assets/" + docHash;

    if (imagesDir) {
      const imageFiles = await fs.readdir(imagesDir);
      for (const name of imageFiles) {
        const srcPath = join(imagesDir, name);
        const st = await fs.stat(srcPath);
        if (st.isFile()) {
          imageCount += 1;
          await publish(() =>
            assets.writeFrom(blogID, assetDir + "/" + name, srcPath)
          );
        }
      }
    }
    stage("images_ms");

    const html = await fs.readFile(htmlPath, "utf-8");
    const $ = cheerio.load(html, { decodeEntities: false });
    // The folder's copy is served as is, so the Doc's comments, private to
    // its editors, come out before it is written
    removeComments($);
    $("img").each(function () {
      const src = $(this).attr("src");
      if (!src) return;
      const normalized = src.replace(/^\.\//, "").trim();
      if (normalized.startsWith("images/")) {
        const filename = normalized.slice(7);
        $(this).attr("src", "/_assets/" + docHash + "/" + filename);
      }
    });

    await publish(() => folder.write(blogID, path, $.html().trim()));
    stage("write_ms");
    console.log(
      clfdate(),
      "Google Drive: exported Doc",
      blogID,
      path,
      `images=${imageCount}`,
      ...Object.entries(timings).map(([name, ms]) => `${name}=${ms}`)
    );
  } finally {
    await fs.remove(zipPath).catch(() => {});
    await fs.remove(extractDir).catch(() => {});
  }
};

module.exports = async (
  blogID,
  drive,
  path,
  { id, md5Checksum, mimeType, modifiedTime },
  { serviceAccountId, folderId, skipHotEnqueue, publish = run } = {}
) => {
  const tempPath = join(tempDir, guid());

  const handleExportSizeLimit = async (err) => {
    if (!isExportSizeLimitError(err)) {
      return false;
    }

    debug("EXPORT size limit exceeded for file", path);

    if (mimeType === "application/vnd.google-apps.document") {
      try {
        const fileMetadata = await drive.files.get({
          fileId: id,
          fields: "exportLinks,id,mimeType,modifiedTime",
          supportsAllDrives: true,
        });
        const exportLinks = fileMetadata?.data?.exportLinks;
        const zipExportUrl = exportLinks?.["application/zip"];

        if (!zipExportUrl) {
          debug(
            "ZIP export fallback unavailable: no application/zip exportLink",
            { fileId: id }
          );
        } else {
          try {
            const zipStream = await fetchZipExportStreamFromExportLink(
              drive,
              zipExportUrl
            );

            await downloadGoogleDocAsZip({
              drive,
              id,
              path,
              blogID,
              zipStream,
              publish,
            });

            debug("ZIP export fallback download SUCCEEDED");
            return "downloadedZipFallback";
          } catch (zipDownloadError) {
            debug("ZIP export fallback download failed", {
              fileId: id,
              error: zipDownloadError?.message || zipDownloadError,
            });
          }
        }
      } catch (metadataError) {
        debug("Failed to fetch exportLinks for ZIP export fallback", {
          fileId: id,
          error: metadataError?.message || metadataError,
        });
      }
    }

    await publish(() =>
      ensurePlaceholder(blogID, path, { code: "SYNC_EXPORT_TOO_LARGE" })
    );
    debug("   created empty file at:", colors.green(path));
    return "placeholder";
  };
  try {
    // Only a Doc edited recently is watched for more edits. A walk exports
    // every Doc it finds changed in its records, which after a deploy or a
    // backfill can be hundreds untouched for days; watching them all
    // squeezed the poll rate of a Doc being typed in from 500ms to ~37s
    // (24 Nov 2026). An edit to an older Doc reaches the poller through
    // changes.list, the search or the recent-folders poller instead.
    if (
      !skipHotEnqueue &&
      id &&
      mimeType === "application/vnd.google-apps.document" &&
      editedRecently(modifiedTime)
    ) {
      let accountServiceAccountId = serviceAccountId;
      let accountFolderId = folderId;

      if (!accountServiceAccountId || !accountFolderId) {
        const account = await database.blog.get(blogID);
        accountServiceAccountId =
          accountServiceAccountId || account?.serviceAccountId;
        accountFolderId = accountFolderId || account?.folderId;
      }

      if (accountServiceAccountId && accountFolderId) {
        hotDocPoller
          .enqueue({
            blogID,
            serviceAccountId: accountServiceAccountId,
            fileId: id,
            folderId: accountFolderId,
          })
          .catch((err) => {
            debug("hotDocPoller enqueue failed", err?.message || err);
          });
      }
    }

    if (mimeType === "application/vnd.google-apps.folder") {
      await publish(() => folder.mkdir(blogID, path));
      debug("MKDIR folder");
      debug("   to:", colors.green(path));
      return { updated: false };
    }

    // create an empty placeholder file for Google App files
    // which are not Documents, e.g. Google Sheets, Slides, etc.
    // this is to avoid downloading them, which would fail
    // because they are not downloadable in the same way as regular files
    if (
      mimeType.startsWith("application/vnd.google-apps.") &&
      mimeType !== "application/vnd.google-apps.document"
    ) {
      await publish(() =>
        ensurePlaceholder(blogID, path, {
          code: "SYNC_UNSUPPORTED",
          kind: mimeType,
        })
      );
      debug(
        "SKIP download of file because it is a Google App file type",
        mimeType
      );
      debug("   created empty file at:", colors.green(path));
      return { updated: false };
    }

    const verifiedContent = await verifyOnBlot(blogID, path, md5Checksum);

    if (verifiedContent) {
      debug("DOWNLOAD file skipped because md5Checksum matches");
      debug("      path:", path);
      debug("   locally:", verifiedContent.checksum);
      debug("    remote:", md5Checksum);
      return { updated: false, verifiedContent };
    }

    debug("DOWNLOAD file");
    debug("   to:", colors.green(path));

    if (mimeType === "application/vnd.google-apps.document") {
      try {
        debug("getting Google Doc as zip from Drive");
        await downloadGoogleDocAsZip({
          drive,
          id,
          path,
          blogID,
          publish,
        });
        debug("DOWNLOAD file SUCCEEDED");
        return { updated: true };
      } catch (err) {
        const handled = await handleExportSizeLimit(err);
        if (handled === "downloadedZipFallback") {
          return { updated: true };
        }
        if (handled === "placeholder") {
          return { updated: false, skippedReason: "exportSizeLimitExceeded" };
        }
        // Not thrown: the outer catch below must not see an error that was
        // already handled here
        return Promise.reject(err);
      }
    }

    // Downloaded already, outside the folder lock, by the detection walk
    // (util/prefetch.js): the same bytes, checked against the same md5
    const prefetched =
      mimeType !== "application/vnd.google-apps.document"
        ? await prefetch.take(id, md5Checksum)
        : null;
    if (prefetched) {
      console.log(
        "Google Drive Sync: using the prefetched download of",
        path,
        `ms_ago=${Date.now() - prefetched.downloadedAt}`
      );
      try {
        await publish(() =>
          folder.writeFrom(blogID, path, prefetched.tempPath, { move: true })
        );
      } finally {
        await fs.remove(prefetched.tempPath).catch(() => {});
      }
      const verified = await verifyPublished(
        blogID,
        path,
        prefetched.hashes
      ).catch(() => null);
      return {
        updated: true,
        verifiedContent: verified,
        prefetched: true,
        downloadedAt: prefetched.downloadedAt,
      };
    }

    debug("getting file from Drive");
    let data;

    // e.g. google docs, sheets, slides
    if (mimeType === "application/vnd.google-apps.document") {
      const res = await drive.files.export(
        {
          fileId: id,
          mimeType: "text/html",
          supportsAllDrives: true,
        },
        {
          responseType: "stream",
        }
      );

      data = res.data;
    } else {
      const res = await drive.files.get(
        { fileId: id, alt: "media", supportsAllDrives: true },
        { responseType: "stream" }
      );
      data = res.data;
    }

    debug("got file from Drive");

    // Source end can precede the final disk write. Pipeline waits for the
    // destination and destroys both streams on error before we publish.
    await streamToFile(data, tempPath);
    const hashes = md5Checksum
      ? await verifyContent(tempPath, md5Checksum)
      : null;
    if (md5Checksum && !hashes) {
      throw new Error(
        "Downloaded content does not match the listed Drive checksum"
      );
    }
    await publish(() =>
      folder.writeFrom(blogID, path, tempPath, { move: true })
    );
    // Publication has succeeded. A concurrent local write (or stat failure)
    // must not suppress the caller's rebuild; simply decline to cache it.
    const verified = await verifyPublished(blogID, path, hashes).catch(
      () => null
    );
    return { updated: true, verifiedContent: verified };
  } catch (e) {
    debug("download error", e);
    await fs.remove(tempPath).catch(() => {});
    const handled = await handleExportSizeLimit(e);
    if (handled === "downloadedZipFallback") {
      return { updated: true };
    }
    if (handled === "placeholder") {
      return { updated: false, skippedReason: "exportSizeLimitExceeded" };
    }
    throw e;
  }
};
