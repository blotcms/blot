// Checks a repository of the git store (app/clients/git/store) at an explicit
// target, with the store's own checks (store/check.js, the ones the daily
// verifier runs on live blogs) and nothing else: no config, no Redis, no blog
// record. It is for proving a copy restored from the offsite backup is
// complete and sound, a local directory (an rclone copy of <blogID>/git/) or a
// scratch prefix of any S3-compatible bucket. It never writes to the target:
// the store it reads through refuses every write.
//
//   cheap (always)  the newest manifest, not older than the one latest.json
//                   names, and every file it names is there at its size
//                   (each pack's .pack, .idx and .rev, the history pack and
//                   pieces' .pack and .idx)
//   --deep          also clone it through the store's own clone code into
//                   scratch, index-pack --strict, fsck --strict, and make
//                   every branch, tag, HEAD and peeled tag of the manifest in
//                   the clone (only if the cheap check passed)
//
// Usage:
//   node scripts/git/check-store.js --dir <restored>/<blogID>/git [--deep]
//   node scripts/git/check-store.js --bucket <b> --prefix <blogID>/git/ [--endpoint <url>] [--region <r>] [--deep]
//   node scripts/git/check-store.js --dir <restored> --all-blogs [--deep]
//
// The target is --dir, or --bucket with --prefix, --endpoint and --region, as
// for import-repo.js (scripts/git/target.js has the credentials). Options:
//
//   --deep           the deep check as well
//   --scratch <dir>  where the deep check builds its clone (default the
//                    system's temporary directory); it needs about the size
//                    of the repository's packs
//   --all-blogs      with --dir: check every <dir>/blog_*/git/ in turn
//
// Prints JSON: { outcome, seq, refs, packs, files, bytes, deep, objects,
// findings }. outcome is "ok", "findings", "empty" (no manifest at all) or
// "removed" (a removal's tombstone); a finding is { check: cheap|deep, kind:
// missing|mismatch|error, detail }. With --all-blogs, stdout is one JSON line
// per blog, as each finishes, with `blog`, then a summary line, as
// verify-store.js --all prints: { summary: true, blogs, deep, outcomes: { ok,
// findings, empty, removed }, withFindings: [{ blog, findings }] }.
//
// Exits 0 if the repository (or every one) is ok, empty or removed, 1 if
// anything was found, 2 for bad arguments.
const fs = require("fs");
const os = require("os");
const path = require("path");

const check = require("../../app/clients/git/store/check");
const { parse, objectStore } = require("./target");

const BLOG_ID = /^blog_[0-9A-Za-z]+$/;

function usage(message) {
  console.error(message + "\n");
  console.error(
    "Usage: node scripts/git/check-store.js (--dir <folder> | --bucket <name> [--prefix <p>] [--endpoint <url>] [--region <r>])\n" +
      "         [--deep] [--scratch <dir>] [--all-blogs]"
  );
  process.exit(2);
}

// The store, refusing every write, so a check cannot change what it checks
function readOnly(store) {
  const refuse = (key) => Promise.reject(new Error("check-store.js does not write to the target (asked to write " + key + ")"));
  return { ...store, put: refuse, putIfAbsent: refuse, delete: refuse };
}

// Checks the repository in `store`: the cheap check, then, if it passed and
// `deep`, the deep one. Never rejects: a check which throws is an "error"
// finding (or, for an error which says something about the store, a
// "missing" or "mismatch" one).
async function checkStore(store, { deep = false, scratchDir }) {
  const result = { outcome: "ok", seq: 0, refs: 0, packs: 0, files: 0, bytes: 0, deep: false, findings: [] };
  const failed = (name, err) => result.findings.push({ check: name, kind: check.verdict(err) || "error", detail: check.scrub(err) });

  try {
    const { state, findings, ...counts } = await check.cheapCheck(store);
    Object.assign(result, counts);
    result.findings.push(...findings.map((finding) => ({ check: "cheap", ...finding })));
    if (state !== "ok") result.outcome = state;
  } catch (err) {
    failed("cheap", err);
  }

  if (deep && result.outcome === "ok" && !result.findings.length) {
    result.deep = true;
    try {
      const { findings, ...counts } = await check.deepCheck({ store, scratchDir });
      result.objects = counts.objects;
      result.findings.push(...findings.map((finding) => ({ check: "deep", ...finding })));
    } catch (err) {
      failed("deep", err);
    }
  }

  if (result.findings.length) result.outcome = "findings";
  return result;
}

// The blogs under a restored root which have a git/ directory, sorted
function blogsUnder(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && BLOG_ID.test(entry.name))
    .map((entry) => entry.name)
    .filter((blogID) => fs.statSync(path.join(root, blogID, "git"), { throwIfNoEntry: false })?.isDirectory())
    .sort();
}

async function main() {
  let options, positional;
  try {
    ({ options, positional } = parse(process.argv.slice(2), { flags: ["deep", "all-blogs"], values: ["scratch"] }));
  } catch (err) {
    usage(err.message);
  }

  if (positional.length) usage("Unexpected argument " + positional[0]);
  if (options["all-blogs"] && (!options.dir || options.bucket)) usage("--all-blogs needs --dir, and no --bucket");
  if (options.dir && !fs.statSync(options.dir, { throwIfNoEntry: false })?.isDirectory()) usage("No such directory: " + options.dir);

  const scratchDir = path.resolve(options.scratch || os.tmpdir());
  const deep = Boolean(options.deep);

  if (!options["all-blogs"]) {
    let target;
    try {
      target = objectStore(options);
    } catch (err) {
      usage(err.message);
    }
    try {
      const result = await checkStore(readOnly(target.store), { deep, scratchDir });
      console.log(JSON.stringify(result, null, 2));
      return result.findings.length ? 1 : 0;
    } finally {
      if (target.client) target.client.destroy();
    }
  }

  const root = path.resolve(options.dir);
  const ids = blogsUnder(root);
  const outcomes = { ok: 0, findings: 0, empty: 0, removed: 0 };
  const withFindings = [];

  for (const blogID of ids) {
    const { store } = objectStore({ dir: path.join(root, blogID, "git") });
    const result = await checkStore(readOnly(store), { deep, scratchDir });
    outcomes[result.outcome]++;
    if (result.findings.length) withFindings.push({ blog: blogID, findings: result.findings });
    console.log(JSON.stringify({ blog: blogID, ...result }));
  }

  console.log(JSON.stringify({ summary: true, blogs: ids.length, deep: deep ? ids.length : 0, outcomes, withFindings }));
  return withFindings.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
