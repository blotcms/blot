const { createTransformer } = require("./transformers");
const { loadMetadata } = require("./loader");
const {
  buildCardHTML,
  replaceWithCard,
  shouldTransform,
  normalizeLayout,
} = require("./dom");
const {
  DEFAULT_LAYOUT,
  MAX_CARDS_PER_ENTRY,
  FETCH_CONCURRENCY,
} = require("./constants");

function render($, callback, options = {}) {
  const layout = normalizeLayout(options.layout);
  const elements = [];
  const htmlTransformer = createTransformer(options.blogID, "link-cards");
  const imageTransformer = createTransformer(
    options.blogID,
    "link-cards-thumbnails"
  );

  $("a").each((_, el) => {
    if (elements.length >= MAX_CARDS_PER_ENTRY) return false;
    if (shouldTransform($, el, options)) {
      elements.push(el);
    }
  });

  (async () => {
    let cursor = 0;

    const worker = async () => {
      while (cursor < elements.length) {
        const el = elements[cursor++];
        const href = $(el).attr("href");
        const target = $(el).attr("target");

        try {
          const metadata = await loadMetadata(href, options.blogID, {
            html: htmlTransformer,
            image: imageTransformer,
          });
          if (!metadata) continue;

          const cardHTML = buildCardHTML(href, metadata, layout, { target });
          replaceWithCard($, el, cardHTML);
        } catch (err) {
          // Ignore errors so other content can continue rendering
        }
      }
    };

    const workerCount = Math.min(FETCH_CONCURRENCY, elements.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
  })()
    .then(() => callback())
    .catch(() => callback());
}

module.exports = {
  render,
  category: "typography",
  isDefault: true,
  title: "Link cards",
  description: "Convert bare external links into rich link cards",
  options: {
    layout: DEFAULT_LAYOUT,
    layoutCompact: true,
    layoutLarge: false,
  },
};
