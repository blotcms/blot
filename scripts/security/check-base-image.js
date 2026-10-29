#!/usr/bin/env node
// The app image (Dockerfile) and the proxy image (proxy/Dockerfile) are built
// on the same node:alpine base, so they can later be combined in one
// container. Each pins it with `ARG NODE_BASE=node:<version>-alpine@sha256:...`.
// This exits non-zero if either is missing, unpinned by digest, or the two
// differ. Run by CI (proxy-image.yml) and by check-advisories.js.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const FILES = ["Dockerfile", "proxy/Dockerfile"];

function readBases() {
  return FILES.map((file) => {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    const m = text.match(/^ARG\s+NODE_BASE=(\S+)/m);
    return { file, base: m ? m[1] : null };
  });
}

function problems() {
  const bases = readBases();
  const out = [];
  for (const { file, base } of bases) {
    if (!base) out.push(file + ": no ARG NODE_BASE=...");
    else if (!/^node:[\d.]+-alpine@sha256:[0-9a-f]{64}$/.test(base))
      out.push(file + ": NODE_BASE must be node:<version>-alpine@sha256:<digest>, got " + base);
  }
  if (new Set(bases.map((b) => b.base)).size > 1)
    out.push("NODE_BASE differs: " + bases.map((b) => b.file + " has " + b.base).join("; "));
  return out;
}

module.exports = { readBases, problems };

if (require.main === module) {
  const found = problems();
  if (found.length) {
    console.error(found.join("\n"));
    process.exit(1);
  }
  console.log("Dockerfile and proxy/Dockerfile share " + readBases()[0].base);
}
