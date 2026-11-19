// A site with exactly one post: a short text post with one image.
const fs = require("fs-extra");
const path = require("path");
const material = require("./material");

const settings = {
  title: "Tiny",
  template: "SITE:blog",
  menu: [
    { url: "/", label: "Home", id: "home" },
    { url: "/archives", label: "Archives", id: "archives" },
  ],
};

// The first prose paragraph found in the demo folders
async function paragraph() {
  for (const file of await material.texts()) {
    const text = await fs.readFile(file, "utf8");
    const found = text
      .split(/\n\s*\n/)
      .map((p) => p.trim().replace(/\s+/g, " "))
      .find((p) => /^[A-Z][^<>{}|`#]{80,400}$/.test(p));
    if (found) return found;
  }
  return "A site with a single post.";
}

// The first small JPEG in the demo folders
async function pickImage() {
  for (const file of await material.images()) {
    if (!/\.jpe?g$/i.test(file)) continue;
    const { size } = await fs.stat(file);
    if (size < 400 * 1024) return file;
  }
  return null;
}

async function build(dir) {
  const image = await pickImage();
  const copied = image
    ? await material.copy(image, path.join(dir, "_Only post.jpg"))
    : false;
  const lines = [
    "Title: The only post",
    "Date: 2024-06-01",
    "",
    await paragraph(),
  ];
  if (copied) lines.push("", "![The only image](_Only post.jpg)");
  await fs.outputFile(
    path.join(dir, "The only post.txt"),
    lines.join("\n") + "\n"
  );
}

module.exports = { settings, build };
