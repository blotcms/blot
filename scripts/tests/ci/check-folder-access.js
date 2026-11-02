#!/usr/bin/env node
// Fails if code outside app/storage reaches a blog's folder on disk directly.
//
// Why: the files a blog owner syncs live in config.blog_folder_dir/<blogID>
// today, but they are moving to S3 (#2258). Everything must read and write
// them through app/storage/folder (read, write, stat, walk, ...), which is the
// only place that knows where they live. A caller which builds its own path
// from blog_folder_dir, or from the deleted helper/localPath, would keep
// working on the local disk and silently break once the folder is in S3.
// Code which needs a real path calls folder.ensureLocal (or folder.path).
//
// Second rule: Blot's own changes to a blog's folder go through the blog's sync
// client, so the provider (Dropbox, Google Drive, iCloud, Git) and the client's
// own records see them. Code outside the places below may read the folder with
// storage/folder, but must not call its mutating methods (write, writeFrom,
// remove, removeAll, rmdir, move, mkdir). Use app/clients/folder.js instead:
// it uses the blog's client, and writes the folder directly only for a blog
// with no client.
//
// Run from anywhere: node scripts/tests/ci/check-folder-access.js

const { execFileSync } = require("child_process");
const { readFileSync } = require("fs");
const { join, basename } = require("path");

const root = join(__dirname, "..", "..", "..");

// helper/localPath is gone, so it may not be mentioned at all. blog_folder_dir
// may only be used by the places below.
const FORBIDDEN = [/helper\/localPath/, /blog_folder_dir/];

// Spec files build and inspect real blog folders on disk.
function isTest(file) {
  return file.split("/").includes("tests") || basename(file) === "tests.js";
}

// Everything which legitimately names blog_folder_dir. Keep this short: a new
// entry should be work on the disk itself, not on a blog's files.
const ALLOWED_PREFIXES = [
  "app/storage/", // the local-disk backend of storage/folder
  "config/index.js", // defines blog_folder_dir
  "app/setup.js", // creates the directory at startup
  // Benchmarks build throwaway blog folders on disk to time converters.
  "scripts/benchmarks/",
  // Finds and deletes directories on disk which belong to no blog.
  "scripts/blog/remove-stray-blog-folders.js",
  // Deploy check that the blog folders' directory is mounted and populated.
  "scripts/deploy/verify-container/checks.js",
  // Read-only scan of file names on disk ahead of the move to S3.
  "scripts/storage/scan-folder-filenames.js",
  // Measures each blog folder's size on disk with du.
  "scripts/user/identify-overdue-users.js",
];

function allowed(file) {
  return (
    isTest(file) ||
    ALLOWED_PREFIXES.some((prefix) => file === prefix || file.startsWith(prefix))
  );
}

// Mutating methods of storage/folder. Only these places may call them.
const MUTATORS = ["write", "writeFrom", "remove", "removeAll", "rmdir", "move", "mkdir"];

const MUTATION_ALLOWED_PREFIXES = [
  "app/storage/", // the backend itself
  // A sync client's own directory: it is the code that applies changes to the
  // folder on behalf of its provider.
  "app/clients/dropbox/",
  "app/clients/google-drive/",
  "app/clients/icloud/",
  "app/clients/git/",
  "app/clients/local/",
  "app/clients/folder.js", // the router
  // Syncs Blot's own demo blogs, which have no client.
  "app/templates/folders/",
  // Deletes a whole blog folder along with the blog.
  "app/models/blog/remove.js",
  // Creates the empty folder of a brand new blog, which has no client yet.
  "app/models/blog/create.js",
  // Recreates a missing folder on a new volume during a host cycle.
  "scripts/host-cycle/reconcile.js",
  // KNOWN GAP: writes a template's package.json straight to the folder,
  // bypassing the blog's client (see TODO). Move it onto clients/folder and
  // delete this entry.
  "app/models/template/removeEnabledFromAllTemplates.js",
  // proxy/e2e seed scripts build fixture blogs before any client exists.
  "proxy/e2e/",
];

function mutationAllowed(file) {
  return (
    isTest(file) ||
    MUTATION_ALLOWED_PREFIXES.some(
      (prefix) => file === prefix || file.startsWith(prefix)
    )
  );
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const REQUIRE = String.raw`require\(\s*["'](?:storage\/folder|storage|(?:\.\.?\/)+(?:app\/)?storage\/folder|(?:\.\.?\/)+folder)["']\s*\)`;

// Finds calls to the mutating methods of storage/folder in one file's source:
// through any name the module is bound to (const x = require(...)), through a
// destructured name, or straight off the require call.
function findMutations(source) {
  const found = [];
  const names = new Set();
  const direct = new Set();
  const lines = source.split("\n");

  const bindRe = new RegExp(String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*` + REQUIRE);
  const destructureRe = new RegExp(String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*` + REQUIRE, "g");
  const assignRe = new RegExp(String.raw`^\s*([A-Za-z_$][\w$]*)\s*=\s*` + REQUIRE);

  for (const line of lines) {
    let m = bindRe.exec(line) || assignRe.exec(line);
    if (m) names.add(m[1]);
  }

  const destructureSource = source.replace(/\n/g, " ");
  let m;
  while ((m = destructureRe.exec(destructureSource))) {
    for (const part of m[1].split(",")) {
      const [original, alias] = part.split(":").map((x) => x.trim());
      if (MUTATORS.includes(original)) direct.add(alias || original);
    }
  }

  const methodList = MUTATORS.join("|");
  const viaName = names.size
    ? new RegExp(String.raw`(?<![\w$.])(?:${[...names].map(escapeRe).join("|")})\s*\.\s*(?:${methodList})\b`)
    : null;
  const viaRequire = new RegExp(REQUIRE + String.raw`\s*\.\s*(?:${methodList})\b`);
  const viaDirect = direct.size
    ? new RegExp(String.raw`(?<![\w$.])(?:${[...direct].map(escapeRe).join("|")})\s*\(`)
    : null;

  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    if (
      (viaName && viaName.test(line)) ||
      viaRequire.test(line) ||
      (viaDirect && viaDirect.test(line) && !bindRe.test(line) && !/\bfunction\b/.test(line))
    ) {
      found.push(i);
    }
  });

  return found;
}

const files = execFileSync("git", ["ls-files", "app", "scripts", "config", "proxy/e2e"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\n")
  .filter((file) => file.endsWith(".js"));

const violations = [];
const mutations = [];

for (const file of files) {
  if (!mutationAllowed(file)) {
    try {
      const source = readFileSync(join(root, file), "utf8");
      const lines = source.split("\n");
      for (const i of findMutations(source)) {
        mutations.push(`${file}:${i + 1}: ${lines[i].trim()}`);
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  if (allowed(file)) continue;

  let lines;
  try {
    lines = readFileSync(join(root, file), "utf8").split("\n");
  } catch (err) {
    if (err.code === "ENOENT") continue; // listed but deleted in the working tree
    throw err;
  }

  lines.forEach((line, i) => {
    if (FORBIDDEN.some((pattern) => pattern.test(line))) {
      violations.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  });
}

if (mutations.length) {
  console.error(
    "Blot's own changes to a blog's folder must go through the blog's sync " +
      "client (see the top of scripts/tests/ci/check-folder-access.js):\n"
  );
  for (const mutation of mutations) console.error("  " + mutation);
  console.error(
    "\nUse write, writeFrom or remove from app/clients/folder.js " +
      "(require(\"clients/folder\")), which uses the blog's client. Only extend " +
      "MUTATION_ALLOWED_PREFIXES for code which is itself a sync client or " +
      "works on whole folders."
  );
  process.exit(1);
}

if (violations.length) {
  console.error(
    "Blog folders must be reached through app/storage/folder, not by path " +
      "(see the top of scripts/tests/ci/check-folder-access.js):\n"
  );
  for (const violation of violations) console.error("  " + violation);
  console.error(
    "\nUse storage/folder (read, write, stat, walk, ...), or folder.ensureLocal " +
      "if you really need a file on disk. Only add to ALLOWED_PREFIXES for " +
      "work on the disk itself."
  );
  process.exit(1);
}

console.log(`Checked ${files.length} files: no direct blog folder access.`);
