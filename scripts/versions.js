// Reads config/versions.env, the one place the project's versions and pins are
// kept. For scripts that need an image or a build arg:
//
//   const versions = require("scripts/versions");   // or a relative path
//   versions.get().NODE_VERSION
//   versions.nodeImage()                            // node:<NODE_VERSION>-alpine
//   versions.buildArgs()                            // ["--build-arg", "K=V", ...]

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "config", "versions.env");

// KEY=VALUE lines; blank lines and # comments are skipped
function parse(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function get() {
  return parse(fs.readFileSync(FILE, "utf8"));
}

// The plain image the e2e and benchmark stubs run on (not the digest-pinned base)
function nodeImage() {
  return "node:" + get().NODE_VERSION + "-alpine";
}

function buildArgs() {
  return Object.entries(get()).flatMap(([k, v]) => ["--build-arg", k + "=" + v]);
}

module.exports = { FILE, parse, get, nodeImage, buildArgs };
