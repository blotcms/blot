// A "torture test" site for template developers: long titles and menu labels,
// extreme images, every file type Blot converts, awkward writing and metadata,
// and awkward folder structure. build(dir) is deterministic: the same files
// and bytes on every run. Source material comes from material.js, and
// anything whose source has gone is skipped, so the site just gets smaller.

const fs = require("fs-extra");
const { join, extname, dirname } = require("path");
const sharp = require("sharp");
const material = require("./material");

const TITLE =
  "The Extraordinarily Long Title of a Torture Test Site for Templates";

// Blot stores external menu links with an id that is not a path
let externalCount = 0;
const external = (label, url) => ({
  id: "17000000000" + String(++externalCount).padStart(2, "0"),
  label,
  url,
});

const settings = {
  title: TITLE,
  template: "SITE:blog",
  menu: [
    { id: "home", label: "Home", url: "/" },
    { id: "archives", label: "Archives", url: "/archives" },
    { id: "search", label: "Search", url: "/search" },
    { id: "/Pages/About.txt", label: "About", url: "/about" },
    {
      id: "/Pages/A page with a very long name that goes on and on and on.txt",
      label:
        "A navigation label that is far too long for any reasonable header to hold in one line",
      url: "/a-page-with-a-very-long-name",
    },
    {
      id: "/Pages/日本語のページ.txt",
      label: "日本語のページ — 長いメニューラベルのテスト",
      url: "/日本語のページ",
    },
    {
      id: "/Pages/Café.txt",
      label: "Café ☕ Crème brûlée Ünïcödé Ångström",
      url: "/cafe",
    },
    {
      id: "/Pages/Contact.md",
      label: "Contact",
      url: "/contact",
    },
    {
      id: "/Pages/Unbroken.txt",
      label:
        "Supercalifragilisticexpialidocious_Pneumonoultramicroscopicsilicovolcanoconiosis_Floccinaucinihilipilification",
      url: "/unbroken",
    },
    external("🌍 External link with emoji 🚀✨", "https://example.com/emoji"),
    external(
      "https://example.com/a/very/long/url/that/is/used/as/the/label/of/a/menu/item/with/no/spaces/at/all",
      "https://example.com/very/long"
    ),
    external("Feed", "/feed.rss"),
    external("RTL: مرحبا بالعالم", "https://example.com/rtl"),
    external("Tags", "/tag/Tag%20with%20spaces"),
    external("X", "https://example.com/x"),
  ],
};

// --- helpers ---------------------------------------------------------------

const WORDS =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat".split(
    " "
  );

function lorem(count, seed = 1) {
  const rand = material.random(seed);
  const out = [];
  for (let i = 0; i < count; i++)
    out.push(WORDS[Math.floor(rand() * WORDS.length)]);
  return out.join(" ");
}

async function write(dir, path, contents) {
  const full = join(dir, path);
  await fs.ensureDir(dirname(full));
  await fs.writeFile(full, contents);
}

// Metadata block, then a blank line, then the body
const post = (meta, body) =>
  Object.entries(meta)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n") +
  "\n\n" +
  body +
  "\n";

// One converter sample per extension, in sorted order
async function samplesByExtension() {
  const supported = new Set([
    ".docx",
    ".odt",
    ".rtf",
    ".org",
    ".gdoc",
    ".webloc",
    ".url",
    ".html",
    ".htm",
    ".md",
    ".markdown",
    ".txt",
    ".heic",
    ".heif",
    ".avif",
    ".tiff",
    ".tif",
    ".webp",
    ".gif",
    ".png",
    ".jpg",
    ".jpeg",
  ]);
  const chosen = {};
  for (const path of await material.converterSamples()) {
    const ext = extname(path).toLowerCase();
    if (supported.has(ext) && !chosen[ext]) chosen[ext] = path;
  }
  return chosen;
}

// A source image for deriving odd shapes: the first demo jpg, or a
// synthetic gradient if there are none
async function baseImage() {
  const jpgs = (await material.images()).filter((path) =>
    /\.jpe?g$/i.test(path)
  );
  for (const path of jpgs) {
    try {
      return await sharp(path).resize(1600, 1600, { fit: "inside" }).toBuffer();
    } catch (e) {
      console.warn("Skipping unreadable image:", path);
    }
  }
  const size = 256;
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      raw[i] = x;
      raw[i + 1] = y;
      raw[i + 2] = (x * y) % 256;
    }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } })
    .jpeg()
    .toBuffer();
}

// Runs a sharp pipeline and writes the result, skipping on failure
async function derive(dir, path, pipeline) {
  try {
    const buffer = await pipeline();
    await write(dir, path, buffer);
    return true;
  } catch (e) {
    console.warn("Skipping derived image", path, "-", e.message);
    return false;
  }
}

// --- writing ----------------------------------------------------------------

const LONG_WORD =
  "Pneumonoultramicroscopicsilicovolcanoconiosis".repeat(4) +
  "Supercalifragilisticexpialidocious".repeat(2);
const LONG_URL =
  "https://example.com/" +
  "a-very-long-path-segment-with-no-break-opportunities/".repeat(4) +
  "?query=" +
  "x".repeat(120) +
  "&another=" +
  "y".repeat(120);

const LONG_LINE =
  "x = [" + Array.from({ length: 120 }, (_, i) => i).join(", ") + "]";

const markdownEdgeCases = `# Markdown edge cases

## Long unbroken things

${LONG_WORD}

${LONG_URL}

A link in text: [${LONG_URL}](${LONG_URL}).

## Wide table

| ${Array.from({ length: 14 }, (_, i) => "Column number " + (i + 1)).join(" | ")} |
| ${Array.from({ length: 14 }, () => "---").join(" | ")} |
| ${Array.from({ length: 14 }, (_, i) => "A fairly long cell value " + i).join(" | ")} |
| ${Array.from({ length: 14 }, () => LONG_WORD.slice(0, 30)).join(" | ")} |

## Footnotes

Here is a sentence with a footnote.[^1] And another one.[^long]

[^1]: A short footnote.
[^long]: A long footnote. ${lorem(120, 7)}

## Maths

Inline maths: $E = mc^2$ and $\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$.

$$
\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
$$

$$
${Array.from({ length: 30 }, (_, i) => "a_{" + i + "}").join(" + ")} = 0
$$

## Code

\`\`\`javascript
const wide = "${"a".repeat(200)}";
${LONG_LINE}
\`\`\`

\`\`\`python
def f(x):
    return [${Array.from({ length: 80 }, (_, i) => "x + " + i).join(", ")}]
\`\`\`

\`\`\`html
<div class="a"><p>${"word ".repeat(60)}</p></div>
\`\`\`

\`\`\`css
a{color:red}${".very-long-selector-name".repeat(12)}{margin:0}
\`\`\`

\`\`\`bash
echo "${"long argument ".repeat(30)}"
\`\`\`

Inline \`code that is very long ${"and keeps going ".repeat(12)}\` in a paragraph.

## Deeply nested lists

${Array.from({ length: 10 }, (_, i) => "    ".repeat(i) + "- Level " + (i + 1) + " " + lorem(4, i)).join("\n")}

1. One
    1. Two
        1. Three
            1. Four
                1. Five
                    1. Six

## Blockquotes in lists

- An item
    > A quote inside a list item.
    > ${lorem(40, 3)}
    >
    > > Nested quote.
- Another item

> A quote with a list:
>
> - one
> - two
>     - nested

## Headings

# Heading 1
## Heading 2
### Heading 3
#### Heading 4
##### Heading 5
###### Heading 6

###### ${"A very long heading ".repeat(10)}

## Embeds

https://www.youtube.com/watch?v=jNQXAC9IVRw

https://twitter.com/jack/status/20

## Misc

Horizontal rule:

---

Raw HTML: <span style="display:inline-block;width:900px">wider than the column</span>

Hard
break, ~~strikethrough~~, **bold**, *italic*, ==highlight==, <kbd>Ctrl</kbd>.
`;

// --- build ----------------------------------------------------------------

async function build(dir) {
  const base = await baseImage();
  const samples = await samplesByExtension();
  const texts = await material.texts();

  // ---- Titles -------------------------------------------------------------
  const titles = {
    "very long title.txt": post(
      {
        Date: "2024-01-01",
        Title: "A very long title " + "that goes on and on ".repeat(12).trim(),
      },
      lorem(60, 1)
    ),
    "unbroken word.txt": post(
      { Date: "2024-01-02", Title: LONG_WORD, Link: "/unbroken-word" },
      lorem(40, 2)
    ),
    "url title.txt": post(
      { Date: "2024-01-03", Title: LONG_URL, Link: "/url-title" },
      lorem(40, 3)
    ),
    "date only.txt": post(
      { Date: "2024-01-04", Title: "2024-01-04" },
      lorem(30, 4)
    ),
    "untitled.txt": post({ Date: "2024-01-05" }, lorem(30, 5)),
    "emoji title.txt": post(
      { Date: "2024-01-06", Title: "🎉🔥 Emoji 👩‍👩‍👧‍👦 title 🏳️‍🌈 🧪" },
      lorem(30, 6)
    ),
    "html title.txt": post(
      {
        Date: "2024-01-07",
        Title:
          "<script>alert(1)</script> &amp; <b>bold</b> &lt;i&gt; \"quotes\" 'single'",
        Link: "/html-title",
      },
      lorem(30, 7)
    ),
    "rtl title.txt": post(
      {
        Date: "2024-01-08",
        Title: "English then עברית ואז العربية and back again",
      },
      lorem(30, 8)
    ),
    "cjk title.txt": post(
      {
        Date: "2024-01-09",
        Title: "Mixed 日本語のタイトル 中文标题 한국어 제목 text",
      },
      lorem(30, 9)
    ),
  };
  for (const [name, body] of Object.entries(titles))
    await write(dir, join("Titles", name), body);

  // ---- Writing -------------------------------------------------------------
  await write(
    dir,
    "Writing/Markdown edge cases.md",
    post({ Date: "2024-02-01", Tags: "markdown, torture" }, markdownEdgeCases)
  );
  await write(
    dir,
    "Writing/One sentence.txt",
    post({ Date: "2024-02-02" }, "Just one sentence.")
  );

  // A very long post, about 10,000 words
  const paragraphs = [];
  let words = 0;
  for (const path of texts) {
    if (words >= 10000) break;
    const raw = await fs.readFile(path, "utf8");
    // Drop the metadata block at the top and headings, keep prose
    const body = raw
      .split(/\n\s*\n/)
      .filter((p) => !/^[A-Za-z-]+:\s/.test(p) && !/^\s*#/.test(p))
      .join("\n\n");
    if (!body.trim()) continue;
    paragraphs.push(body);
    words += body.split(/\s+/).length;
  }
  for (let i = 0; words < 10000; i++) {
    const p = lorem(120, 100 + i);
    paragraphs.push(p);
    words += 120;
  }
  await write(
    dir,
    "Writing/A very long post.txt",
    post(
      { Date: "2024-02-03" },
      "# A very long post\n\n" + paragraphs.join("\n\n")
    )
  );

  // ---- Metadata ------------------------------------------------------------
  await write(
    dir,
    "Drafts/An unpublished draft.txt",
    post({ Date: "2024-03-01" }, "# An unpublished draft\n\n" + lorem(40, 11))
  );
  await write(
    dir,
    "Metadata/Scheduled.txt",
    post(
      { Date: "2999-01-01", Title: "A scheduled post from the far future" },
      lorem(40, 12)
    )
  );
  await write(
    dir,
    "Metadata/Link override.txt",
    post(
      { Date: "2024-03-02", Link: "/custom/link/override" },
      "# Link override\n\n" + lorem(30, 13)
    )
  );
  const manyTags = Array.from({ length: 40 }, (_, i) =>
    i % 5 === 0 ? "Tag number " + i + " with spaces" : "tag" + i
  );
  await write(
    dir,
    "Metadata/Forty tags.txt",
    post(
      { Date: "2024-03-03", Tags: manyTags.join(", ") },
      "# Forty tags\n\n" + lorem(30, 14)
    )
  );
  await write(
    dir,
    "Metadata/Odd tags.txt",
    post(
      {
        Date: "2024-03-04",
        Tags:
          "Tag with spaces, Café, naïve, 日本語, 🌈 rainbow, ÅNGSTRÖM, a/b, UPPER, upper, " +
          "long".repeat(25),
      },
      "# Odd tags\n\n" + lorem(30, 15)
    )
  );
  await write(
    dir,
    "[Path tag] [Another path tag]/Path tags.txt",
    post({ Date: "2024-03-05" }, "# Path tags\n\nTagged from the folder name.")
  );
  await write(
    dir,
    "Metadata/Custom fields.txt",
    post(
      {
        Date: "2024-03-06",
        Subtitle: "A custom subtitle",
        Author: "Ada Lovelace",
        "Reading time": "42 minutes",
        Rating: "5",
        Summary: "A custom summary " + lorem(30, 16),
        Teaser: "A custom teaser",
      },
      "# Custom fields\n\n" + lorem(30, 17)
    )
  );
  await write(
    dir,
    "Metadata/Non-ASCII permalink.txt",
    post(
      { Date: "2024-03-07", Link: "/café/日本語/привет/🙂" },
      "# Non-ASCII permalink\n\n" + lorem(30, 18)
    )
  );
  await write(
    dir,
    "Metadata/No comments no search.txt",
    post(
      { Date: "2024-03-08", Comments: "No", Search: "No", Menu: "Yes" },
      "# No comments, hidden from search\n\n" + lorem(30, 19)
    )
  );

  // ---- Pages ---------------------------------------------------------------
  const pages = {
    "About.txt": "# About\n\n" + lorem(60, 21),
    "Contact.md":
      "# Contact\n\nEmail: [hello@example.com](mailto:hello@example.com)",
    "A page with a very long name that goes on and on and on.txt":
      "# A page with a very long name\n\n" + lorem(30, 22),
    "日本語のページ.txt": "# 日本語のページ\n\n" + lorem(30, 23),
    "Café.txt": "# Café\n\n" + lorem(30, 24),
    "Unbroken.txt": "# " + LONG_WORD + "\n\n" + lorem(30, 25),
  };
  for (const [name, body] of Object.entries(pages))
    await write(dir, join("Pages", name), body + "\n");
  await write(
    dir,
    "Pages/Hidden.txt",
    post({ Menu: "no", Link: "/hidden" }, "# Hidden page\n\nNot in the menu.")
  );

  // ---- Every file type -----------------------------------------------------
  // One post per extension, copied from the converters' samples. Images get a
  // date in their path so they sort sensibly.
  let day = 1;
  for (const ext of Object.keys(samples).sort()) {
    const date = "2023-05-" + String(day++).padStart(2, "0");
    const name = date + " Sample" + ext;
    await material.copy(samples[ext], join(dir, "File types", name));
  }

  // ---- Images --------------------------------------------------------------
  const rand = material.random(42);
  const IMG = "Images";
  const jpeg = (img, q = 70) => img.jpeg({ quality: q });

  await derive(dir, `${IMG}/2022-01-01 Strip 4000x40.jpg`, () =>
    jpeg(sharp(base).resize(4000, 40, { fit: "cover" })).toBuffer()
  );
  await derive(dir, `${IMG}/2022-01-02 Sliver 40x4000.jpg`, () =>
    jpeg(sharp(base).resize(40, 4000, { fit: "cover" })).toBuffer()
  );
  await derive(dir, `${IMG}/2022-01-03 One pixel.png`, () =>
    sharp(base).resize(1, 1, { fit: "cover" }).png().toBuffer()
  );
  await derive(dir, `${IMG}/2022-01-04 Eight by eight.png`, () =>
    sharp(base).resize(8, 8, { fit: "cover" }).png().toBuffer()
  );
  await derive(dir, `${IMG}/2022-01-05 Large 6000x4000.jpg`, async () => {
    const small = await sharp(base)
      .resize(120, 80, { fit: "cover" })
      .toBuffer();
    return jpeg(
      sharp(small).resize(6000, 4000, { kernel: "cubic" }),
      30
    ).toBuffer();
  });
  await derive(dir, `${IMG}/2022-01-06 Transparent.png`, () =>
    sharp({
      create: {
        width: 600,
        height: 400,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="600" height="400" xmlns="http://www.w3.org/2000/svg"><circle cx="300" cy="200" r="150" fill="rgba(200,30,30,0.6)"/><rect x="40" y="40" width="120" height="120" fill="rgba(30,30,200,0.5)"/></svg>'
          ),
        },
      ])
      .png()
      .toBuffer()
  );
  await derive(dir, `${IMG}/2022-01-07 Animated.gif`, () => {
    const size = 64;
    const colours = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ];
    const frames = Buffer.concat(
      colours.map(([r, g, b]) => {
        const frame = Buffer.alloc(size * size * 3);
        for (let i = 0; i < size * size; i++) {
          frame[i * 3] = r;
          frame[i * 3 + 1] = g;
          frame[i * 3 + 2] = b;
        }
        return frame;
      })
    );
    return sharp(frames, {
      raw: { width: size, height: size * 3, channels: 3, pageHeight: size },
    })
      .gif({ delay: [300, 300, 300], loop: 0 })
      .toBuffer();
  });
  await write(
    dir,
    `${IMG}/2022-01-08 Vector.svg`,
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200"><rect width="400" height="200" fill="#eef"/><circle cx="100" cy="100" r="60" fill="#c33"/><text x="180" y="110" font-size="32" font-family="sans-serif">SVG</text></svg>\n'
  );
  await derive(dir, `${IMG}/2022-01-09 Rotated by EXIF.jpg`, () =>
    sharp(base)
      .resize(600, 400, { fit: "cover" })
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 70 })
      .toBuffer()
  );
  await derive(dir, `${IMG}/2022-01-10 Greyscale.jpg`, () =>
    jpeg(sharp(base).resize(600, 400, { fit: "cover" }).greyscale()).toBuffer()
  );
  await derive(
    dir,
    `${IMG}/2022-01-11 ${"A very long image file name ".repeat(6).trim()}.jpg`,
    () => jpeg(sharp(base).resize(600, 400, { fit: "cover" })).toBuffer()
  );
  await derive(dir, `${IMG}/2022-01-12 Square.jpg`, () =>
    jpeg(sharp(base).resize(500, 500, { fit: "cover" })).toBuffer()
  );

  // Gallery post with many images
  const demoImages = (await material.images()).filter((p) =>
    /\.jpe?g$/i.test(p)
  );
  const many = [];
  for (let i = 0; i < Math.min(24, demoImages.length); i++) {
    const name = `_photo-${String(i + 1).padStart(2, "0")}.jpg`;
    const ok = await derive(dir, `Gallery/${name}`, () =>
      jpeg(sharp(demoImages[i]).resize(800, 800, { fit: "inside" })).toBuffer()
    );
    if (ok) many.push(`![Photo ${i + 1}](/Gallery/${name})`);
  }
  await write(
    dir,
    "Gallery/Many images.md",
    post(
      { Date: "2024-04-01" },
      "# Many images\n\n" + (many.join("\n\n") || lorem(20, 30))
    )
  );
  await write(
    dir,
    "Gallery/Images with captions.md",
    post(
      { Date: "2024-04-02" },
      "# Images with captions\n\n" +
        (many
          .slice(0, 3)
          .map(
            (m, i) => m + "\n\n*" + lorem(10 + Math.floor(rand() * 30), i) + "*"
          )
          .join("\n\n") || lorem(20, 31))
    )
  );

  // ---- Structure -----------------------------------------------------------
  // A folder post: the folder name ends in +, its files become one post
  const folderPost = "Structure/A folder post +";
  await write(
    dir,
    `${folderPost}/01 Introduction.md`,
    "# A folder post\n\n" + lorem(50, 40) + "\n"
  );
  const folderImages = demoImages.slice(0, 2);
  for (let i = 0; i < folderImages.length; i++)
    await derive(dir, `${folderPost}/02 Photos/0${i + 1} Photo.jpg`, () =>
      jpeg(
        sharp(folderImages[i]).resize(800, 800, { fit: "inside" })
      ).toBuffer()
    );
  await write(
    dir,
    `${folderPost}/03 Conclusion.md`,
    "## Conclusion\n\n" + lorem(50, 41) + "\n"
  );
  await write(
    dir,
    `${folderPost}/_notes.md`,
    "Ignored: starts with an underscore.\n"
  );

  // Deeply nested folders
  await write(
    dir,
    "Structure/Level 2/Level 3/Level 4/Level 5/Level 6/Level 7/Deeply nested.txt",
    post({ Date: "2024-05-01" }, "# Deeply nested\n\n" + lorem(30, 42))
  );
  await write(
    dir,
    "Structure/Ünïcödé Földer/日本語フォルダ/Пример.txt",
    post({ Date: "2024-05-02" }, "# Non-ASCII folder names\n\n" + lorem(30, 43))
  );
  const longFolder = "A folder with a very long name ".repeat(5).trim();
  await write(
    dir,
    `Structure/${longFolder}/${"A file with a very long name ".repeat(6).trim()}.txt`,
    post(
      { Date: "2024-05-03" },
      "# Very long file and folder names\n\n" + lorem(30, 44)
    )
  );
  await write(
    dir,
    "Structure/Café ☕ résumé — 日本語 🙂.txt",
    post({ Date: "2024-05-04" }, lorem(30, 45))
  );

  // Files Blot ignores
  await write(
    dir,
    "_ignored.txt",
    "# Ignored\n\nThis file starts with an underscore.\n"
  );
  await write(
    dir,
    "Structure/_ignored folder/Inside.txt",
    "# Ignored folder\n"
  );
  await write(
    dir,
    "_ignored-image.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>\n'
  );
}

module.exports = { settings, build };
