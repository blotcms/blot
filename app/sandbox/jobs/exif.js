// Reads an image's metadata with exiftool, from stdin, in the jail or
// in-process (see ../index.js). Args: { fields: ["Make", "MWG:Description"] }:
// tag names, each optionally qualified by a group. MWG's composite tags are
// on (-use MWG). meta maps each field asked for to its plain value, or is null.
// Throws if exiftool fails.

const fs = require("fs");
const { spawn } = require("child_process");

// Matches maxOutputBytes in proxy/unit/sandbox/jail.js, and what execFile's
// default maxBuffer allowed when exif.js ran exiftool directly
const MAX_STDOUT = 1024 * 1024;
const MAX_VALUE = 64 * 1024;
const MAX_FIELDS = 64;

// An optional group ("XMP-dc", "MWG") and a tag name ("Caption-Abstract"),
// both starting with a letter. Every field is passed to exiftool with a group,
// "All" when it has none, so that no field can be read as an exiftool option.
const FIELD =
  /^(?:([A-Za-z][A-Za-z0-9-]{0,31}):)?([A-Za-z][A-Za-z0-9-]{0,63})$/;

function command() {
  // The jail has no /bin and no env, so exiftool's #! line can't be used
  if (process.env.EXIFTOOL_PATH) return [process.env.EXIFTOOL_PATH, []];
  if (fs.existsSync("/usr/bin/perl") && fs.existsSync("/usr/bin/exiftool")) {
    return ["/usr/bin/perl", ["/usr/bin/exiftool"]];
  }
  return ["exiftool", []];
}

function exiftool(tags, input) {
  return new Promise((resolve, reject) => {
    const [file, prefix] = command();
    // A pipe for stderr too: "ignore" opens /dev/null, which the jail doesn't have
    const child = spawn(
      file,
      prefix.concat(["-j", "-use", "MWG", ...tags, "-"]),
      { stdio: "pipe" }
    );
    child.stderr.resume();
    const chunks = [];
    let size = 0;
    let failed = false;

    const fail = (err) => {
      if (failed) return;
      failed = true;
      child.kill("SIGKILL");
      reject(err);
    };

    child.on("error", fail);
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_STDOUT)
        return fail(new Error("exiftool output too large"));
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (failed) return;
      if (code !== 0) return reject(new Error("exiftool failed"));
      resolve(Buffer.concat(chunks).toString());
    });
    child.stdin.end(input);
  });
}

async function run(args, input) {
  const fields = args && args.fields;
  if (
    !Array.isArray(fields) ||
    !fields.length ||
    fields.length > MAX_FIELDS ||
    !fields.every((f) => typeof f === "string" && FIELD.test(f))
  ) {
    throw new Error("invalid fields");
  }

  // exiftool's JSON keys are tag names without their group, so two fields
  // with the same name couldn't be told apart
  const names = fields.map((f) => FIELD.exec(f)[2]);
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) {
    throw new Error("invalid fields");
  }

  const tags = fields.map(
    (f, i) => `-${FIELD.exec(f)[1] || "All"}:${names[i]}`
  );
  const parsed = JSON.parse(await exiftool(tags, input));
  const raw = Array.isArray(parsed) && parsed.length ? parsed[0] : null;
  if (!raw || typeof raw !== "object") return { meta: null, outputs: [] };

  const meta = {};
  for (const [i, field] of fields.entries()) {
    if (!Object.prototype.hasOwnProperty.call(raw, names[i])) continue;
    const value = raw[names[i]];
    if (typeof value === "string") meta[field] = value.slice(0, MAX_VALUE);
    else if (typeof value === "number" || typeof value === "boolean")
      meta[field] = value;
  }
  return { meta, outputs: [] };
}

module.exports = { run };
