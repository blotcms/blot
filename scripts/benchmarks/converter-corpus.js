"use strict";

// Typical inputs for converter-bench.js (--corpus typical): the kind of file
// people actually save into a blog folder, not the converters' own test
// fixtures, which are mostly one-line edge cases. Everything is generated, so
// nothing binary is committed and the same run makes the same documents:
//
//   - markdown: a short note (~1 KB, with metadata), a typical post (~4.5 KB:
//     headings, lists, links, a table, a blockquote, footnotes, a code block,
//     inline HTML) and a long essay (~40 KB)
//   - org, rtf, html, docx, odt: the typical post, written by pandoc. The
//     docx and odt hold two images, as most do
//   - img: a 2400x1600 photo-like JPEG (~1 MB) and a 1200x800 PNG screenshot
//
// docx, odt, rtf and org need pandoc to make them: the one the converters use
// (BLOT_PANDOC_PATH, else pandoc on the PATH). Images need sharp.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// A small seeded PRNG (mulberry32), so the corpus is the same on every run
function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  "the of and to in is that it for was on are as with his they at be this " +
  "from have or by one had not but what all were when we there can an your " +
  "which their said if do will each about how up out them then she many some " +
  "so these would other into has more her two like him see time could no make " +
  "than first been its who now people my made over did down only way find use " +
  "may water long little very after words called just where most know get " +
  "through back much before go good new write our used me man too any day same " +
  "right look think also around another came come work three word must because " +
  "does part even place well such here take why things help put years different " +
  "away again off went old number great tell men say small every found still " +
  "between name should home big give air line set own under read last never us " +
  "left end along while might next sound below saw something thought both few " +
  "those always looked show large often together asked house world going want"
).split(" ");

function sentence(rand, min = 8, max = 22) {
  const n = min + Math.floor(rand() * (max - min));
  const words = [];
  for (let i = 0; i < n; i++) words.push(WORDS[Math.floor(rand() * WORDS.length)]);
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return words.join(" ") + ".";
}

// A paragraph with the inline markup people use: emphasis, links, code
function paragraph(rand, sentences = 4) {
  const parts = [];
  for (let i = 0; i < sentences; i++) {
    let s = sentence(rand);
    const r = rand();
    if (r < 0.15) s = s.replace(/(\w+) (\w+)/, "*$1 $2*");
    else if (r < 0.25) s = s.replace(/(\w+) (\w+)/, "**$1 $2**");
    else if (r < 0.4) s = s.replace(/(\w+) (\w+)/, "[$1 $2](https://example.com/" + Math.floor(rand() * 1000) + ")");
    else if (r < 0.45) s = s.replace(/(\w+)\./, "`$1`.");
    parts.push(s);
  }
  return parts.join(" ");
}

function shortNote(rand) {
  return [
    "Title: A short note",
    "Date: 2026-03-14",
    "Tags: notes, ideas",
    "",
    paragraph(rand, 4),
    "",
    paragraph(rand, 3),
    "",
    "- " + sentence(rand, 4, 8),
    "- " + sentence(rand, 4, 8),
    "- " + sentence(rand, 4, 8),
    "",
    paragraph(rand, 2),
    "",
  ].join("\n");
}

function typicalPost(rand, { images = [] } = {}) {
  const out = ["# A typical post", "", paragraph(rand, 5), ""];
  for (let section = 1; section <= 4; section++) {
    out.push("## " + sentence(rand, 2, 5).replace(/\.$/, ""), "");
    out.push(paragraph(rand, 5) + "[^" + section + "]", "");
    if (images[section - 1]) out.push("![" + sentence(rand, 2, 4) + "](" + images[section - 1] + ")", "");
    out.push(paragraph(rand, 4), "");
    if (section === 1) {
      out.push("- " + sentence(rand, 4, 10), "- " + sentence(rand, 4, 10), "    - " + sentence(rand, 4, 10), "- " + sentence(rand, 4, 10), "");
    }
    if (section === 2) {
      out.push("> " + paragraph(rand, 2), "", "1. " + sentence(rand, 4, 10), "2. " + sentence(rand, 4, 10), "3. " + sentence(rand, 4, 10), "");
    }
    if (section === 3) {
      out.push("| Name | Count | Notes |", "|------|------:|-------|");
      for (let i = 0; i < 5; i++) out.push("| " + WORDS[i * 7] + " | " + Math.floor(rand() * 100) + " | " + sentence(rand, 3, 6) + " |");
      out.push("");
    }
    if (section === 4) {
      out.push("```js", "function greet(name) {", "  return `Hello, ${name}!`;", "}", "```", "");
      out.push('<div class="aside">', "", paragraph(rand, 2), "", "</div>", "");
    }
  }
  for (let i = 1; i <= 4; i++) out.push("[^" + i + "]: " + sentence(rand, 6, 14), "");
  return out.join("\n");
}

function longEssay(rand) {
  const out = ["Title: A long essay", "Date: 2026-01-02", "", "# A long essay", ""];
  for (let section = 1; section <= 16; section++) {
    out.push("## " + sentence(rand, 2, 5).replace(/\.$/, ""), "");
    for (let p = 0; p < 6; p++) out.push(paragraph(rand, 5), "");
    if (section % 4 === 0) out.push("> " + paragraph(rand, 2), "");
    if (section % 3 === 0) out.push("- " + sentence(rand), "- " + sentence(rand), "- " + sentence(rand), "");
  }
  return out.join("\n");
}

function pandocPath() {
  return process.env.BLOT_PANDOC_PATH || "pandoc";
}

function pandoc(args, cwd) {
  execFileSync(pandocPath(), args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
}

// A photo-like image: smooth gradients with noise, so it compresses like a
// photo rather than a flat colour. With no noise, bands of flat colour, which
// compress like a screenshot.
async function photo(sharp, width, height, rand, amount = 40) {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const noise = amount ? (rand() - 0.5) * amount : 0;
      const band = amount ? 1 : Math.floor(y / 40) % 4;
      data[i] = Math.max(0, Math.min(255, amount ? (x / width) * 200 + 30 + noise : 60 * band));
      data[i + 1] = Math.max(0, Math.min(255, amount ? (y / height) * 180 + 40 + noise : 240 - 30 * band));
      data[i + 2] = Math.max(0, Math.min(255, amount ? 120 + Math.sin(x / 50) * 60 + noise : 250));
    }
  }
  return sharp(data, { raw: { width, height, channels } });
}

// The corpus for the converters asked for, written into dir. Returns
// { converterName: [absolute paths] }.
async function build(dir, converters) {
  fs.mkdirSync(dir, { recursive: true });
  const rand = prng(20261104);
  const want = (name) => converters.includes(name);
  const files = {};
  const write = (converter, name, content) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    (files[converter] = files[converter] || []).push(file);
  };

  const short = shortNote(rand);
  const typical = typicalPost(rand);
  const long = longEssay(rand);

  if (want("markdown")) {
    write("markdown", "short-note.md", short);
    write("markdown", "typical-post.md", typical);
    write("markdown", "long-essay.md", long);
  }

  const needsPandoc = ["org", "rtf", "html", "docx", "odt"].filter(want);
  if (!needsPandoc.length && !want("img")) return files;

  const work = fs.mkdtempSync(path.join(dir, "work-"));
  try {
    const needsImages = want("img") || want("docx") || want("odt");
    let sharp = null;
    if (needsImages) {
      sharp = require("sharp");
      await (await photo(sharp, 2400, 1600, rand)).jpeg({ quality: 85 }).toFile(path.join(work, "photo.jpg"));
      await (await photo(sharp, 1200, 800, rand, 0)).png().toFile(path.join(work, "screenshot.png"));
    }

    if (want("img")) {
      for (const name of ["photo.jpg", "screenshot.png"]) {
        write("img", name, fs.readFileSync(path.join(work, name)));
      }
    }

    if (needsPandoc.length) {
      fs.writeFileSync(path.join(work, "typical.md"), typical);
      fs.writeFileSync(
        path.join(work, "typical-images.md"),
        typicalPost(prng(7), { images: ["photo.jpg", "screenshot.png"] })
      );

      if (want("org")) {
        pandoc(["typical.md", "-t", "org", "-o", "typical.org"], work);
        write("org", "typical-post.org", fs.readFileSync(path.join(work, "typical.org")));
      }
      if (want("rtf")) {
        pandoc(["typical.md", "-s", "-t", "rtf", "-o", "typical.rtf"], work);
        write("rtf", "typical-post.rtf", fs.readFileSync(path.join(work, "typical.rtf")));
      }
      if (want("html")) {
        pandoc(["typical.md", "-s", "-t", "html5", "--metadata", "title=A typical post", "-o", "typical.html"], work);
        write("html", "typical-post.html", fs.readFileSync(path.join(work, "typical.html")));
      }
      for (const format of ["docx", "odt"]) {
        if (!want(format)) continue;
        pandoc(["typical.md", "-o", "typical." + format], work);
        pandoc(["typical-images.md", "-o", "typical-images." + format], work);
        write(format, "typical-post." + format, fs.readFileSync(path.join(work, "typical." + format)));
        write(format, "typical-post-images." + format, fs.readFileSync(path.join(work, "typical-images." + format)));
      }
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  return files;
}

module.exports = { build, shortNote, typicalPost, longEssay, prng };
