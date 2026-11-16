// Runs pandoc on a document in the sandbox (app/sandbox/jobs/pandoc.js, or in
// a jail its worker, app/sandbox/jobs/pandoc-worker.lua), which picks pandoc's
// options from these args:
//
//   const { html, dir, media } = await pandoc({ from: "docx" }, { path });
//
// input is a Buffer or { path }. files ({ bibliography, csl }, markdown only)
// are local paths, sent after the document. media is [{ name, data }]: what
// pandoc extracted from a docx or odt, which the caller writes itself, named
// relative to dir, the directory the HTML's image paths start with. The job
// names the archive's file for each image rather than sending its bytes, so a
// document with many images fits in the jail, and they are read from the
// archive here with the unzip job, as many at a time as a reply holds. A document
// pandoc can't convert, or that takes too long, rejects with "Pandoc exited
// ...", and pandoc killed by the jail's memory limit with code SANDBOX_KILLED,
// which emails the admin.

const fs = require("fs-extra");
const { extname } = require("path");
const sandbox = require("sandbox");
const alerts = require("sandbox/alerts");
const { HARD } = require("sandbox/jobs/unzip");

// Each batch of a document's images: as many as one reply holds
const MEDIA_LIMITS = {
  maxEntries: HARD.maxEntries,
  maxBytes: HARD.maxBytes,
  maxRatio: HARD.maxRatio,
};

// The archive's files, by name, read in batches of what one reply holds
async function readEntries(input, names) {
  const found = new Map();
  let wanted = [...new Set(names)];

  while (wanted.length) {
    const { meta, outputs } = await sandbox.run(
      "unzip",
      Object.assign({ only: wanted }, MEDIA_LIMITS),
      input
    );
    if (!meta || typeof meta !== "object" || !Array.isArray(meta.files))
      throw new Error("pandoc: invalid media reply");
    if (meta.error)
      throw new Error(
        "pandoc: could not read the document's images: " + meta.error.reason
      );
    if (!meta.files.length || meta.files.length !== outputs.length)
      throw new Error("pandoc: could not read the document's images");
    meta.files.forEach((name, i) => found.set(name, outputs[i]));
    wanted = wanted.filter((name) => !found.has(name));
  }

  return found;
}

// A media name pandoc gave: relative, with no empty, . or .. parts
function isMediaName(name) {
  return (
    typeof name === "string" &&
    name.length <= 1024 &&
    name
      .split("/")
      .every(
        (part) => part && part !== "." && part !== ".." && !part.includes("\0")
      )
  );
}

async function pandoc(args, input, files = {}) {
  args = Object.assign({}, args);
  // The document alone, for its images
  const document = input;

  const parts = [];
  for (const key of ["bibliography", "csl"]) {
    if (!files[key]) continue;
    const data = await fs.readFile(files[key]);
    // pandoc picks a bibliography's format by its extension
    const extension = extname(files[key]);
    args[key] = {
      length: data.length,
      extension: /^\.[A-Za-z0-9]{1,16}$/.test(extension) ? extension : ".txt",
    };
    parts.push(data);
  }
  if (parts.length)
    input = Buffer.concat(
      [Buffer.isBuffer(input) ? input : await fs.readFile(input.path)].concat(
        parts
      )
    );

  let reply;
  try {
    reply = await sandbox.run("pandoc", args, input);
  } catch (err) {
    // The broker kills a pandoc worker that takes too long on one document
    // (proxy/unit/sandbox/broker.js), which is the document's doing, as the
    // job's own timeout is in-process
    if (err.code !== "SANDBOX_TIMEOUT") throw err;
    throw new Error(
      "Pandoc exited with code null (SIGKILL) (timed out): " + err.message,
      { cause: err }
    );
  }
  const { meta, outputs } = reply;

  if (!meta || typeof meta !== "object")
    throw new Error("pandoc: invalid reply");

  if (meta.error) {
    const { code, signal, timedOut, ms, stderr } = meta.error;
    const err = new Error(
      "Pandoc exited with code " +
        code +
        (signal ? " (" + signal + ")" : "") +
        " in " +
        ms +
        "ms" +
        (timedOut ? " (timed out)" : "") +
        ": " +
        stderr
    );
    // A kill the job didn't send is the jail's memory limit, not the document.
    // The job survives it, so the broker can't report it: this does.
    if (signal && !timedOut) {
      err.code = "SANDBOX_KILLED";
      alerts.jobFailed("pandoc", err);
    }
    throw err;
  }

  const { media, entries } = meta;
  const inline = Array.isArray(entries)
    ? entries.filter((entry) => entry === null).length
    : -1;
  if (
    typeof meta.dir !== "string" ||
    !Array.isArray(media) ||
    !media.every(isMediaName) ||
    !Array.isArray(entries) ||
    entries.length !== media.length ||
    !entries.every((entry) => entry === null || typeof entry === "string") ||
    outputs.length !== inline + 1
  ) {
    throw new Error("pandoc: invalid reply");
  }

  // The images named by their file in the archive come from it, the rest
  // from the reply, in order
  const fromArchive = entries.filter((entry) => entry !== null);
  const read = fromArchive.length
    ? await readEntries(document, fromArchive)
    : new Map();
  let next = 1;

  return {
    html: outputs[0].toString("utf8"),
    dir: meta.dir,
    media: media.map((name, i) => {
      if (entries[i] === null) return { name, data: outputs[next++] };
      if (!read.has(entries[i]))
        throw new Error("pandoc: the document has no file " + entries[i]);
      return { name, data: read.get(entries[i]) };
    }),
  };
}

module.exports = pandoc;
