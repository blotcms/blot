// Deterministic generators for the mega benchmark's entries: everything is
// drawn from one seeded RNG, so base and head render the same sites.
const seedrandom = require("seedrandom");

const WORDS = (
  "the of and a to in is you that it he was for on are as with his they at " +
  "be this have from or one had by word but not what all were we when your " +
  "can said there use an each which she do how their if will up other about " +
  "out many then them these so some her would make like him into time has " +
  "look two more write go see number no way could people my than first water " +
  "been call who oil its now find long down day did get come made may part " +
  "archive garden letter river signal lantern harbour notebook orchard meadow"
).split(" ");

const DAY = 24 * 60 * 60 * 1000;
const EPOCH = Date.UTC(2026, 0, 1);

function rng(seed) {
  return seedrandom(seed);
}

// A value between a spread's percentiles, interpolated on a log scale so the
// tail is long like the real one: { p50, p90, p99, max }, min p50 / 4.
function sample(random, spread) {
  const points = [
    [0, Math.max(1, spread.p50 / 4)],
    [0.5, spread.p50],
    [0.9, spread.p90],
    [0.99, spread.p99],
    [1, spread.max],
  ];
  const u = random();

  for (let i = 1; i < points.length; i++) {
    const [u1, v1] = points[i];
    const [u0, v0] = points[i - 1];
    if (u > u1) continue;
    const t = (u - u0) / (u1 - u0 || 1);
    return Math.round(Math.exp(Math.log(v0) + t * (Math.log(v1) - Math.log(v0))));
  }

  return spread.max;
}

function words(random, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(WORDS[Math.floor(random() * WORDS.length)]);
  }
  return out.join(" ");
}

// About 64KB of varied HTML that entry bodies are cut from
function htmlBlock(random) {
  const parts = [];
  let length = 0;
  let n = 0;

  while (length < 64 * 1024) {
    let part;
    const kind = n++ % 9;
    if (kind === 4) part = `<h2 id="section-${n}">${words(random, 4)}</h2>`;
    else if (kind === 7)
      part = `<pre><code>${words(random, 30).replace(/ /g, "\n  ")}</code></pre>`;
    else
      part =
        `<p>${words(random, 40)} <a href="/linked-${n}">${words(random, 3)}</a> ` +
        `<em>${words(random, 5)}</em> ${words(random, 30)}.</p>`;
    parts.push(part);
    length += part.length + 1;
  }

  return parts.join("\n");
}

// `chars` of HTML from the block, starting at a random offset
function cut(random, block, chars) {
  const start = Math.floor(random() * block.length);
  let out = block.slice(start);
  while (out.length < chars) out += "\n" + block;
  return out.slice(0, chars);
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Tag names and how likely each is to be drawn (power law)
function tagPool(shape) {
  const names = [];
  const weights = [];
  for (let i = 0; i < shape.tags; i++) {
    names.push(`Topic ${i + 1}`);
    weights.push(1 / Math.pow(i + 1, shape.tagSkew || 1));
  }
  const total = weights.reduce((a, b) => a + b, 0);
  return { names, weights: weights.map((w) => w / total) };
}

function drawTags(random, pool, count) {
  const chosen = new Set();
  count = Math.min(count, pool.names.length);
  while (chosen.size < count) {
    let u = random();
    let i = 0;
    while (i < pool.weights.length - 1 && u > pool.weights[i]) u -= pool.weights[i++];
    chosen.add(pool.names[i]);
  }
  return [...chosen];
}

// The entries of one site, oldest first. Each is a complete stored entry, as
// the build would hand it to Entry.set.
function entries(shape, seed) {
  const random = rng(seed);
  const block = htmlBlock(random);
  const pool = shape.tags ? tagPool(shape) : null;
  const span = (shape.years || 1) * 365 * DAY;
  const total = shape.entries + (shape.pages || 0);
  const result = [];

  for (let i = 0; i < total; i++) {
    const isPage = i >= shape.entries;
    const n = String(i + 1).padStart(5, "0");
    const title = `${isPage ? "Page" : "Entry"} ${n} ${words(random, 3)}`;
    const slug = slugify(title);
    const path = isPage ? `/Pages/${slug}.md` : `/Posts/${slug}.md`;
    const titleTag = `<h1 id="${slug}">${title}</h1>`;
    const body = cut(random, block, sample(random, shape.html));
    const teaserBody = body.slice(0, sample(random, shape.teaser));
    const dateStamp = EPOCH - span + Math.floor((span * (i + random())) / total);
    const tags =
      pool && !isPage ? drawTags(random, pool, sample(random, shape.tagsPerEntry)) : [];

    result.push({
      id: path,
      guid: "entry_" + slug,
      url: "",
      permalink: "",
      title,
      titleTag,
      body,
      summary: words(random, 20),
      teaser: titleTag + teaserBody,
      teaserBody,
      more: teaserBody.length < body.length,
      html: titleTag + body,
      slug,
      name: path.split("/").pop(),
      path,
      size: body.length,
      tags,
      dependencies: [],
      backlinks: [],
      internalLinks: [],
      menu: isPage,
      page: isPage,
      deleted: false,
      draft: false,
      scheduled: false,
      thumbnail:
        random() < 0.5
          ? {}
          : {
              small: { url: `/_image_cache/${slug}-s.jpg`, width: 160, height: 120 },
              medium: { url: `/_image_cache/${slug}-m.jpg`, width: 640, height: 480 },
              large: { url: `/_image_cache/${slug}-l.jpg`, width: 1600, height: 1200 },
            },
      dateStamp,
      created: dateStamp,
      updated: dateStamp,
      contentHash: slug,
      metadata: { author: words(random, 2), mood: words(random, 1) },
      exif: {},
    });
  }

  return result;
}

module.exports = { rng, sample, words, cut, htmlBlock, entries };
