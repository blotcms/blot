#!/usr/bin/env node
// Fails if a tracked text file under scripts/ or .github/ contains an emoji.
//
// Why: deploy and benchmark output lands in logs, step summaries and PR
// comments, where emoji are inconsistent and hard to grep for. Write plain text
// ("[ok]", "[FAIL]", "[WARN]", "running") instead. User content (templates,
// fixtures, app code that processes emoji) lives outside these directories.
//
// The check uses \p{Extended_Pictographic}, which also matches the plain
// symbols (c), (R) and TM, so those three are allowed.
//
// Run from anywhere: node scripts/tests/ci/check-no-emoji.js

const { execFileSync } = require("child_process");
const { readFileSync } = require("fs");
const { join } = require("path");

const root = join(__dirname, "..", "..", "..");
const DIRS = ["scripts", ".github"];
const ALLOWED = new Set([0x00a9, 0x00ae, 0x2122]); // (c), (R), TM
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

function isEmoji(ch) {
  return PICTOGRAPHIC.test(ch) && !ALLOWED.has(ch.codePointAt(0));
}

const files = execFileSync("git", ["ls-files", "-z", "--", ...DIRS], { cwd: root })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const hits = [];

for (const file of files) {
  let text;
  try {
    text = readFileSync(join(root, file), "utf8");
  } catch (err) {
    continue; // deleted or unreadable
  }
  if (text.includes("\0")) continue; // binary

  text.split("\n").forEach((line, i) => {
    const found = [...line].filter(isEmoji);
    if (found.length) hits.push({ file, line: i + 1, found: [...new Set(found)].join(" ") });
  });
}

if (hits.length) {
  console.error("Emoji found in scripts/ or .github/ (use plain text instead):");
  for (const { file, line, found } of hits) console.error(`  ${file}:${line}: ${found}`);
  process.exit(1);
}

console.log(`No emoji in ${files.length} files under ${DIRS.join(", ")}.`);
