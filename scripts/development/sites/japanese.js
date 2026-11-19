// Japanese (CJK, no spaces between words) development test site. The writing lives in
// ./japanese; build() copies it into a folder and adds a few demo images.

const fs = require("fs-extra");
const path = require("path");
const material = require("./material");

const SOURCE = path.join(__dirname, "japanese");
const PHOTOS = 3;

module.exports = {
  settings: {
    title: "ひだまり手帖",
    template: "SITE:blog",
    menu: [
      { url: "/", label: "ホーム", id: "home" },
      { url: "/archives", label: "アーカイブ", id: "archives" },
      { url: "/search", label: "検索", id: "search" },
      { url: "/about", label: "このブログについて", id: "/Pages/About.txt" },
      { url: "/contact", label: "お問い合わせ", id: "/Pages/連絡先.txt" },
    ],
  },

  build: async function build(dir) {
    await fs.copy(SOURCE, dir);

    // Posts refer to _photo-1.jpg, _photo-2.jpg... Pick that many demo
    // images (the same ones every run) and drop the lines of any that
    // could not be copied.
    const found = (await material.images()).filter((file) =>
      /\.jpe?g$/i.test(file)
    );
    const next = material.random(5);
    const available = [...found];
    const missing = new Set();

    for (let n = 1; n <= PHOTOS; n++) {
      const name = `_photo-${n}.jpg`;
      const pick = available.splice(
        Math.floor(next() * available.length),
        1
      )[0];
      if (!pick || !(await material.copy(pick, path.join(dir, name))))
        missing.add(name);
    }

    for (const file of await material.walk(dir)) {
      if (!file.endsWith(".txt")) continue;
      const text = await fs.readFile(file, "utf8");
      if (!text.includes("_photo-")) continue;
      const cleaned = text
        .split("\n")
        .filter((line) => ![...missing].some((name) => line.includes(name)))
        .join("\n");
      if (cleaned !== text) await fs.writeFile(file, cleaned);
    }
  },
};
