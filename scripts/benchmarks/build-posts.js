#!/usr/bin/env node
// Build-path micro benchmark: writes generated markdown posts into a fresh
// blog's folder, then times a full rebuild (sync/rebuild) and a second
// rebuild of the same, unchanged folder - what a resync or a client reconnect
// costs. Reports wall time per file, how many proxy purges each pass asked
// for and whether it bumped the cacheID, so work done for unchanged files shows.
//
// Run with NODE_PATH=app against a throwaway Redis and the test MinIO (the
// same BLOT_STORAGE_* and BLOT_AWS_* settings the specs use); pandoc must be on
// the PATH (or BLOT_PANDOC_PATH):
//
//   node scripts/benchmarks/build-posts.js [--files 100] [--kb 12]
//     [--passes 2] [--then rebuild|resync] [--profile out.cpuprofile]
//     [--output result.json]
//
// --then resync makes the passes after the first a resync of every file
// through sync(), as a client sends after a reconnect, instead of a rebuild.
const fs = require("fs");
const { promisify } = require("util");
const seedrandom = require("seedrandom");

const args = parseArgs(process.argv.slice(2));
const FILES = Number(args.files || 100);
const KB = Number(args.kb || 12);
const PASSES = Number(args.passes || 2);

const WORDS = (
  "the of and a to in is you that it he was for on are as with his they at " +
  "be this have from or one had by word but not what all were we when your " +
  "archive garden letter river signal lantern harbour notebook orchard meadow"
).split(" ");

function words(random, n) {
  const out = [];
  for (let i = 0; i < n; i++)
    out.push(WORDS[Math.floor(random() * WORDS.length)]);
  return out.join(" ");
}

// A markdown post of about `kb` KB: headings, paragraphs with links and
// emphasis, quotes, lists and code, so every build step has something to do
function post(random, i, kb) {
  const parts = [
    `Title: Post ${i} ${words(random, 3)}`,
    `Date: ${2020 + (i % 6)}-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`,
    `Tags: ${words(random, 1)}, ${words(random, 1)}`,
    "",
    `# Post ${i} ${words(random, 3)}`,
    "",
  ];
  let length = 0;
  let n = 0;
  while (length < kb * 1024) {
    let part;
    const kind = n++ % 8;
    if (kind === 2) part = `## ${words(random, 4)}`;
    else if (kind === 4)
      part = `> ${words(random, 30)} "${words(random, 4)}" -- ${words(random, 2)}...`;
    else if (kind === 5)
      part = [1, 2, 3, 4].map(() => `- ${words(random, 8)}`).join("\n");
    else if (kind === 7)
      part = "```\n" + words(random, 20).replace(/ /g, "\n") + "\n```";
    else
      part =
        `${words(random, 30)} [${words(random, 2)}](/post-${Math.floor(random() * 100)}) ` +
        `*${words(random, 3)}* "${words(random, 6)}" ${words(random, 30)}.`;
    if (n === 4) part += "\n\n<!-- more -->";
    parts.push(part, "");
    length += part.length + 2;
  }
  return parts.join("\n");
}

// Count every blog-wide proxy purge (models/blog/flushCache, which sync calls
// after each file and Blog.set calls on any change): installed before
// anything requires it, so every caller gets the counting wrapper.
let flushes = 0;
const flushCachePath = require.resolve("models/blog/flushCache");
const flushCache = require(flushCachePath);
require.cache[flushCachePath].exports = function () {
  flushes++;
  return flushCache.apply(this, arguments);
};

async function main() {
  const Blog = require("models/blog");
  const getBlog = promisify(Blog.get);

  await require("../tests/util/bucket")();

  await promisify(require("templates"))({ watch: false });

  const context = {};
  await promisify(require("../tests/util/createUser").bind(context))();
  const result = { user: context.user };
  await promisify(require("../tests/util/createBlog").bind(result))();
  const blog = result.blog;

  const random = seedrandom("build-posts");
  for (let i = 0; i < FILES; i++) {
    await blog.write({
      path: `/Posts/post-${i}.md`,
      content: post(random, i, KB),
    });
  }

  let session;
  if (args.profile) {
    const inspector = require("inspector");
    session = new inspector.Session();
    session.connect();
    const post = promisify(session.post.bind(session));
    session.postAsync = post;
    await post("Profiler.enable");
    await post("Profiler.start");
  }

  // A resync: what a client sends on reconnect, an update of every file
  // through sync(), as Dropbox, Google Drive or iCloud do after a reset
  const sync = require("sync");
  const paths = [];
  for (let i = 0; i < FILES; i++) paths.push(`/Posts/post-${i}.md`);
  const resync = () =>
    new Promise((resolve, reject) => {
      sync(blog.id, async (err, folder, done) => {
        if (err) return reject(err);
        const update = promisify(folder.update);
        try {
          for (const path of paths) await update(path);
        } catch (e) {
          return done(e, () => reject(e));
        }
        done(null, (err) => (err ? reject(err) : resolve()));
      });
    });

  const log = console.log;
  const passes = [];
  // A full rebuild first, then rebuilds or resyncs of the unchanged folder
  const kinds = ["rebuild"];
  for (let pass = 1; pass < PASSES; pass++) kinds.push(args.then || "rebuild");
  for (let pass = 0; pass < PASSES; pass++) {
    flushes = 0;
    const cacheIDBefore = (await getBlog({ id: blog.id })).cacheID;
    console.log = function () {};
    const startedAt = performance.now();
    if (kinds[pass] === "resync") await resync();
    else await blog.rebuild();
    const ms = performance.now() - startedAt;
    console.log = log;
    passes.push({
      pass: pass + 1,
      kind: kinds[pass],
      total_ms: Math.round(ms),
      ms_per_file: Math.round((ms / FILES) * 100) / 100,
      proxy_flushes: flushes,
      cacheid_changed:
        (await getBlog({ id: blog.id })).cacheID !== cacheIDBefore,
    });
  }

  if (session) {
    const { profile } = await session.postAsync("Profiler.stop");
    fs.writeFileSync(args.profile, JSON.stringify(profile));
  }

  const output = { files: FILES, kb: KB, passes };
  console.log(JSON.stringify(output, null, 2));
  if (args.output)
    fs.writeFileSync(args.output, JSON.stringify(output, null, 2));
  process.exit(0);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
