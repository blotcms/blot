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

const files = execFileSync("git", ["ls-files", "app", "scripts", "config"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\n")
  .filter((file) => file.endsWith(".js"));

const violations = [];

for (const file of files) {
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
