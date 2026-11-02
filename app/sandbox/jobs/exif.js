// Reads an image's EXIF with exiftool, from stdin, in the jail or in-process
// (see ../index.js). Args: { fields: ["Make", ...] }. meta is the first object
// of exiftool's JSON, reduced to those fields and to plain values, or null.
// Throws if exiftool fails.

const fs = require("fs");
const { spawn } = require("child_process");

// Matches maxOutputBytes in proxy/unit/sandbox/jail.js, and what execFile's
// default maxBuffer allowed when exif.js ran exiftool directly
const MAX_STDOUT = 1024 * 1024;
const MAX_VALUE = 64 * 1024;
const MAX_FIELDS = 64;

function command() {
  // The jail has no /bin and no env, so exiftool's #! line can't be used
  if (process.env.EXIFTOOL_PATH) return [process.env.EXIFTOOL_PATH, []];
  if (fs.existsSync("/usr/bin/perl") && fs.existsSync("/usr/bin/exiftool")) {
    return ["/usr/bin/perl", ["/usr/bin/exiftool"]];
  }
  return ["exiftool", []];
}

function exiftool(input) {
  return new Promise((resolve, reject) => {
    const [file, prefix] = command();
    // A pipe for stderr too: "ignore" opens /dev/null, which the jail doesn't have
    const child = spawn(file, prefix.concat(["-j", "-"]), { stdio: "pipe" });
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
      if (size > MAX_STDOUT) return fail(new Error("exiftool output too large"));
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
    !fields.every((f) => typeof f === "string" && /^[A-Za-z0-9]{1,64}$/.test(f))
  ) {
    throw new Error("invalid fields");
  }

  const parsed = JSON.parse(await exiftool(input));
  const raw = Array.isArray(parsed) && parsed.length ? parsed[0] : null;
  if (!raw || typeof raw !== "object") return { meta: null, outputs: [] };

  const meta = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(raw, field)) continue;
    const value = raw[field];
    if (typeof value === "string") meta[field] = value.slice(0, MAX_VALUE);
    else if (typeof value === "number" || typeof value === "boolean") meta[field] = value;
  }
  return { meta, outputs: [] };
}

module.exports = { run };
