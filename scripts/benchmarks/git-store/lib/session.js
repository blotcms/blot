// A run of one repository under one network profile: switches toxiproxy to the
// profile, starts a fresh server (so a new process and an empty cache are
// "cold"), and summarises what the server counted.
const fs = require("fs");
const os = require("os");
const path = require("path");
const toxiproxy = require("./toxiproxy");
const profiles = require("./profiles");
const { startServer } = require("./harness");

const WORK = process.env.GIT_STORE_SPIKE_WORK || path.join(os.tmpdir(), "git-store-spike");

const PROFILES = Object.keys(profiles);

async function withSession({ blogID, profile, cacheBytes = 1024 ** 3, attempts = 3, env = {}, via }, fn) {
  await toxiproxy.useProfile(profile);
  const cacheDir = path.join(WORK, "cache-" + blogID + "-" + profile);
  fs.rmSync(cacheDir, { recursive: true, force: true });
  const server = await startServer({
    blogID,
    via: via || (profile === "direct" ? "direct" : "proxied"),
    cacheDir,
    cacheBytes,
    attempts,
    env,
  });
  try {
    return await fn(server);
  } finally {
    await server.stop();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

// What a /__take returned, as numbers for a table
function summarise(taken) {
  const http = taken.counts.http;
  const n = (...names) => names.reduce((sum, name) => sum + ((http[name] && http[name].n) || 0), 0);
  const all = Object.values(http).reduce((sum, row) => sum + row.n, 0);
  return {
    requests: all,
    gets: n("GetObjectCommand"),
    heads: n("HeadObjectCommand"),
    puts: n("PutObjectCommand", "UploadPartCommand", "CreateMultipartUploadCommand", "CompleteMultipartUploadCommand", "AbortMultipartUploadCommand"),
    lists: n("ListObjectsV2Command"),
    idxReads: (taken.counts.ops["read.idx"] || { n: 0 }).n,
    packReads: (taken.counts.ops["read.pack"] || { n: 0 }).n,
    bytesIn: taken.counts.bytesIn,
    bytesOut: taken.counts.bytesOut,
    rssPeakMB: taken.rssPeakMB,
    rssBaseMB: taken.rssBaseMB,
    byCommand: Object.fromEntries(Object.entries(http).map(([k, v]) => [k.replace("Command", ""), v.n])),
  };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

module.exports = { withSession, summarise, median, PROFILES, WORK };
