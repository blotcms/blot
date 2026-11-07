const util = require("util");

// Makes each console call one line of output, so a grep for a blog, sync or
// request id finds the whole entry: an error prints as its name, message,
// status or code and the top of its stack, objects print on one line, and a
// newline left in a string is written as \n. Installed in production only
// (app/index.js); development keeps Node's multi-line output.

const METHODS = ["log", "info", "warn", "error", "debug"];
// Stack frames kept after the message
const FRAMES = 3;
// Properties of an error worth keeping, when they are strings or numbers
const FIELDS = ["status", "statusCode", "code", "error_summary"];

function formatError(err) {
  let line = `${err.name || "Error"}: ${err.message}`;

  for (const field of FIELDS) {
    const value = err[field];
    if (typeof value === "string" || typeof value === "number") {
      line += ` ${field}=${value}`;
    }
  }

  // The Dropbox SDK's DropboxResponseError keeps its summary in its body
  if (err.error && typeof err.error.error_summary === "string") {
    line += ` error_summary=${err.error.error_summary}`;
  }

  const frames = String(err.stack || "")
    .split("\n")
    .filter((frame) => /^\s+at /.test(frame))
    .slice(0, FRAMES)
    .map((frame) => frame.trim().slice(3));

  if (frames.length) line += ` at ${frames.join(" < ")}`;

  return line;
}

function format(...args) {
  const line = util.formatWithOptions(
    { breakLength: Infinity, depth: 3 },
    ...args.map((arg) => (arg instanceof Error ? formatError(arg) : arg))
  );

  return line.replace(/\r?\n/g, "\\n");
}

function install() {
  for (const method of METHODS) {
    const original = console[method];
    console[method] = function (...args) {
      original.call(console, format(...args));
    };
  }
}

module.exports = { install, format, formatError };
