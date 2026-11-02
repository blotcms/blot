// Runs pandoc on a document in the sandbox (app/sandbox/jobs/pandoc.js), which
// picks pandoc's options from these args:
//
//   const { html, dir, media } = await pandoc({ from: "docx" }, { path });
//
// input is a Buffer or { path }. files ({ bibliography, csl }, markdown only)
// are local paths, sent after the document. media is [{ name, data }]: what
// pandoc extracted from a docx or odt, which the caller writes itself, named
// relative to dir, the directory the HTML's image paths start with. A document
// pandoc can't convert rejects with "Pandoc exited ...", and pandoc killed by
// the jail's memory limit with code SANDBOX_KILLED, which emails the admin.

const fs = require("fs-extra");
const { extname } = require("path");
const sandbox = require("sandbox");
const alerts = require("sandbox/alerts");

// A media name pandoc gave: relative, with no empty, . or .. parts
function isMediaName(name) {
  return (
    typeof name === "string" &&
    name.length <= 1024 &&
    name.split("/").every((part) => part && part !== "." && part !== ".." && !part.includes("\0"))
  );
}

async function pandoc(args, input, files = {}) {
  args = Object.assign({}, args);

  const parts = [];
  for (const key of ["bibliography", "csl"]) {
    if (!files[key]) continue;
    const data = await fs.readFile(files[key]);
    // pandoc picks a bibliography's format by its extension
    const extension = extname(files[key]);
    args[key] = { length: data.length, extension: /^\.[A-Za-z0-9]{1,16}$/.test(extension) ? extension : ".txt" };
    parts.push(data);
  }
  if (parts.length) input = Buffer.concat([Buffer.isBuffer(input) ? input : await fs.readFile(input.path)].concat(parts));

  const { meta, outputs } = await sandbox.run("pandoc", args, input);

  if (!meta || typeof meta !== "object") throw new Error("pandoc: invalid reply");

  if (meta.error) {
    const { code, signal, timedOut, ms, stderr } = meta.error;
    const err = new Error(
      "Pandoc exited with code " + code + (signal ? " (" + signal + ")" : "") +
        " in " + ms + "ms" + (timedOut ? " (timed out)" : "") + ": " + stderr
    );
    // A kill the job didn't send is the jail's memory limit, not the document.
    // The job survives it, so the broker can't report it: this does.
    if (signal && !timedOut) {
      err.code = "SANDBOX_KILLED";
      alerts.jobFailed("pandoc", err);
    }
    throw err;
  }

  const media = meta.media;
  if (
    typeof meta.dir !== "string" ||
    !Array.isArray(media) ||
    !media.every(isMediaName) ||
    outputs.length !== media.length + 1
  ) {
    throw new Error("pandoc: invalid reply");
  }

  return {
    html: outputs[0].toString("utf8"),
    dir: meta.dir,
    media: media.map((name, i) => ({ name, data: outputs[i + 1] })),
  };
}

module.exports = pandoc;
