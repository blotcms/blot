// A stress site for pagination, archives and tags: about 1,500 posts over 15
// years, 40 image posts, ~300 tags with a Zipf-like distribution, two pages.
// Text is recombined from the demo folders, so the site is built from whatever
// material is there and is smaller if some of it has gone.
const fs = require("fs-extra");
const path = require("path");
const material = require("./material");

const settings = {
  title: "Huge",
  template: "SITE:blog",
  // Blot has no built-in tags index page (tags live at /tagged/<tag>)
  menu: [
    { url: "/", label: "Home", id: "home" },
    { url: "/archives", label: "Archives", id: "archives" },
    { url: "/search", label: "Search", id: "search" },
    { url: "/about", label: "About", id: "/Pages/About.txt" },
  ],
};

const POSTS = 1500;
const IMAGE_POSTS = 40;
const IMAGE_BUDGET = 45 * 1024 * 1024;
const START = Date.UTC(2011, 0, 1);
const SPAN = Date.UTC(2026, 0, 1) - START;

const SPECIAL_TAGS = [
  "Café culture",
  "Résumé",
  "Zürich",
  "Español",
  "Naïve art",
  "São Paulo",
  "Machine learning",
  "Open source",
  "Slow Food",
  "TYPOGRAPHY",
  "Field Notes",
  "Año nuevo",
  "Crème brûlée",
  "Long reads",
  "Work in progress",
];

const pad = (n) => String(n).padStart(2, "0");
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Prose paragraphs, headings and sentence-based titles from the demo texts
async function corpus() {
  const paragraphs = [];
  const headings = [];
  for (const file of await material.texts()) {
    const text = await fs.readFile(file, "utf8");
    if (/^\s*```|^\s*</m.test(text) && /<(script|style|canvas)/i.test(text))
      continue;
    for (const block of text.split(/\n\s*\n/)) {
      const b = block.trim().replace(/\s*\n\s*/g, " ");
      const heading = /^#{1,3}\s+([^#].{2,60})$/.exec(b);
      if (heading) headings.push(heading[1].replace(/[*_`[\]]/g, "").trim());
      else if (/^[A-Z“"][^<>{}|`#[\]]{70,900}$/.test(b)) paragraphs.push(b);
    }
  }
  return { paragraphs, headings };
}

function makeTitle(rand, { paragraphs, headings }) {
  if (headings.length && rand() < 0.3) return pick(rand, headings);
  const sentence = pick(rand, paragraphs).split(/(?<=[.!?])\s+/)[0];
  const words = sentence
    .replace(/[^\p{L}\p{N}\s'’-]/gu, "")
    .split(/\s+/)
    .filter(Boolean);
  const n = 3 + Math.floor(rand() * 5);
  const start = Math.floor(rand() * Math.max(1, words.length - n));
  return capital(words.slice(start, start + n).join(" ")) || "Untitled";
}

// About 300 tags: special ones plus words taken from the corpus
function vocabulary(rand, { paragraphs }) {
  const words = new Set();
  for (const p of paragraphs)
    for (const w of p.match(/\p{L}{6,12}/gu) || []) words.add(w.toLowerCase());
  const list = [...words].sort();
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  const out = [...SPECIAL_TAGS];
  for (const w of list) {
    if (out.length >= 300) break;
    out.push(rand() < 0.15 ? capital(w) : w);
  }
  return out;
}

function dateFor(rand) {
  const d = new Date(START + Math.floor(rand() * SPAN));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate()
  )} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function body(rand, c, kind) {
  const count =
    kind === "one"
      ? 0
      : kind === "long"
        ? 25 + Math.floor(rand() * 35)
        : 2 + Math.floor(rand() * 3);
  if (kind === "one") {
    return pick(rand, c.paragraphs).split(/(?<=[.!?])\s+/)[0];
  }
  const parts = [];
  for (let i = 0; i < count; i++) {
    if (
      c.headings.length &&
      (kind === "long" ? i % 6 === 0 : i === 2 && rand() < 0.3)
    )
      parts.push("## " + pick(rand, c.headings));
    parts.push(pick(rand, c.paragraphs));
  }
  return parts.join("\n\n");
}

// Smaller images first, so the 40 fit the size budget
async function pickImages(rand) {
  const candidates = [];
  for (const file of await material.images()) {
    if (!/\.jpe?g$/i.test(file) || /\/_[^/]*$/.test(file)) continue;
    candidates.push({ file, size: (await fs.stat(file)).size });
  }
  candidates.sort((a, b) => a.size - b.size || (a.file < b.file ? -1 : 1));
  const chosen = [];
  let total = 0;
  for (const c of candidates.slice(0, 200)) {
    if (chosen.length >= IMAGE_POSTS) break;
    if (total + c.size > IMAGE_BUDGET) continue;
    chosen.push(c.file);
    total += c.size;
  }
  void rand;
  return chosen;
}

async function build(dir) {
  const rand = material.random(20260101);
  const c = await corpus();
  if (!c.paragraphs.length)
    c.paragraphs.push(
      "There is nothing here yet, only a placeholder paragraph for the Huge site."
    );
  const vocab = vocabulary(rand, c);
  const tail = vocab.slice(-80); // each used once
  const head = vocab.slice(0, -80);
  const weights = head.map((_, i) => 1 / (i + 1));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const zipf = () => {
    let r = rand() * totalWeight;
    for (let i = 0; i < head.length; i++) {
      r -= weights[i];
      if (r <= 0) return head[i];
    }
    return head[0];
  };

  const images = await pickImages(rand);
  const embedded = [];
  const posts = [];

  // Image posts: date and one tag in the file name
  for (let i = 0; i < images.length; i++) {
    const date = dateFor(rand).slice(0, 10);
    const title = path
      .basename(images[i], path.extname(images[i]))
      .replace(/^\d{4}-\d{2}-\d{2}\s+/, "")
      .replace(/\s*\[[^\]]*\]/g, "")
      .replace(/[/\\]/g, "-")
      .trim();
    const name = `${date} [${zipf()}] ${title}.jpg`;
    if (await material.copy(images[i], path.join(dir, "Photos", name)))
      embedded.push(name);
  }

  const tailQueue = [...tail];
  const heavy = new Set();
  while (heavy.size < 6) heavy.add(Math.floor(rand() * POSTS));

  for (let i = 0; i < POSTS; i++) {
    const r = rand();
    const kind = r < 0.1 ? "one" : r < 0.13 ? "long" : "normal";
    const title = makeTitle(rand, c);
    let tags = [];
    const t = rand();
    if (heavy.has(i)) {
      const n = 30 + Math.floor(rand() * 21);
      while (tags.length < n) {
        const tag = pick(rand, vocab);
        if (!tags.includes(tag)) tags.push(tag);
      }
    } else if (t < 0.05) tags = [];
    else if (t < 0.8) tags = [zipf()];
    else tags = [zipf(), zipf(), ...(rand() < 0.5 ? [zipf()] : [])];
    if (tailQueue.length && rand() < 0.08) tags.push(tailQueue.pop());
    tags = [...new Set(tags)];

    const lines = [`Title: ${title}`, `Date: ${dateFor(rand)}`];
    if (tags.length) lines.push(`Tags: ${tags.join(", ")}`);
    lines.push("");
    let text = body(rand, c, kind);
    const image =
      embedded.length && rand() < 0.08 ? pick(rand, embedded) : null;
    if (image) text += `\n\n![${title}](${image})`;
    lines.push(text);

    const slug = title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .slice(0, 40);
    const file = image ? "Photos" : "Posts";
    posts.push([
      path.join(
        dir,
        file,
        `${pad(Math.floor(i / 100))}-${slug || "post"}-${i}.txt`
      ),
      lines.join("\n") + "\n",
    ]);
  }
  // Any tail tags left over go on extra posts so each is used at least once
  for (const tag of tailQueue) {
    posts.push([
      path.join(dir, "Posts", `tail-${tag.replace(/\W+/g, "-")}.txt`),
      `Title: ${capital(tag)}\nDate: ${dateFor(rand)}\nTags: ${tag}\n\n${pick(rand, c.paragraphs)}\n`,
    ]);
  }
  for (const [file, text] of posts) await fs.outputFile(file, text);

  const about = [
    "# About",
    "",
    "Huge is a stress site for pagination, archives and tags. Everything on it is recombined from the demo sites' writing and photographs.",
    "",
    pick(rand, c.paragraphs),
  ];
  const colophon = [
    "# Colophon",
    "",
    "Set in the system fonts. Posts are generated deterministically from a fixed seed.",
    "",
    pick(rand, c.paragraphs),
  ];
  await fs.outputFile(
    path.join(dir, "Pages", "About.txt"),
    about.join("\n") + "\n"
  );
  await fs.outputFile(
    path.join(dir, "Pages", "Colophon.txt"),
    colophon.join("\n") + "\n"
  );
}

module.exports = { settings, build };
