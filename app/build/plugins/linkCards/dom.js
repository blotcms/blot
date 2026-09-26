const { URL } = require("url");
const he = require("he");

const { DEFAULT_LAYOUT, VALID_LAYOUTS } = require("./constants");

// Block-level elements a link card can be dropped straight into. A link whose
// wrapping <p> is just the link is handled separately (the <p> is replaced).
const FLOW_CONTENT_HOSTS = new Set([
  "li",
  "td",
  "div",
  "dd",
  "blockquote",
  "section",
  "figure",
]);

function buildCardHTML(href, metadata, layout, anchorOptions = {}) {
  const safeHref = escapeAttribute(href);
  const pieces = [];

  const imageMarkup = buildImageMarkup(metadata, layout);
  const iconMarkup = buildIconMarkup(metadata);
  if (imageMarkup) {
    pieces.push(`<div class="link-card__thumbnail">${imageMarkup}</div>`);
  }

  const title = metadata.title || metadata.siteName || href;
  const description = metadata.description || "";
  const displayURL = metadata.siteName || formatDisplayURL(href);

  const text = [];

  if (title) {
    text.push(`<h3 class="link-card__title">${escapeHTML(title)}</h3>`);
  }

  if (description) {
    text.push(
      `<p class="link-card__description">${escapeHTML(description)}</p>`
    );
  }

  const urlMarkup = buildURLMarkup(displayURL, iconMarkup);
  if (urlMarkup) {
    text.push(urlMarkup);
  }

  pieces.push(`<div class="link-card__content">${text.join("")}</div>`);

  // Carry over target="_blank" if the externalLinks plugin (which runs first)
  // set it on the original anchor, so enabling "open external links in a new
  // tab" still works for links that became cards.
  const targetAttr = anchorOptions.target
    ? ` target="${escapeAttribute(anchorOptions.target)}"`
    : "";

  const anchor = `<a class="link-card__anchor" href="${safeHref}"${targetAttr} rel="noopener noreferrer">${pieces.join(
    ""
  )}</a>`;

  return `<article class="link-card link-card--${layout}">${anchor}</article>`;
}

function replaceWithCard($, el, html) {
  const $el = $(el);
  const text = textContent($el.text());

  // An <article> cannot live inside a <p> (or an inline wrapper inside one),
  // so when the link sits in a paragraph that contains nothing but the link,
  // replace the whole paragraph. closest() rather than parent() so a link
  // wrapped in <em>/<strong> is still handled.
  const paragraph = $el.closest("p");

  if (paragraph.length && textContent(paragraph.text()) === text) {
    paragraph.replaceWith(html);
  } else {
    $el.replaceWith(html);
  }
}

function shouldTransform($, el, options) {
  const href = $(el).attr("href");
  const text = $(el).text();

  if (!href || !text) return false;
  if ($(el).children().length) return false;

  const normalizedHref = textContent(href);
  const normalizedText = textContent(text);

  if (normalizedHref !== normalizedText) return false;

  if (!/^https?:\/\//i.test(href)) return false;

  // Reject credentials in the URL up front - see sanitizeRemoteURL.
  try {
    const parsed = new URL(href);
    if (parsed.username || parsed.password) return false;
  } catch (err) {
    return false;
  }

  if (!isExternal(href, options)) return false;

  // A link card is flow content and replaceWithCard() needs a block-level
  // element to stand in for. Accept only the shapes Blot's Markdown produces
  // for "a link on its own line": an anchor whose surrounding paragraph is
  // just the link (that <p> gets replaced - covers **url** / *url* wrappers
  // too), or an anchor that is the entire content of a list item, table
  // cell, div, blockquote, etc. A bare URL in a heading, or an inline-wrapped
  // link with no paragraph around it, is rejected so we never emit
  // <h1><article>… or <p><article>…
  const paragraph = $(el).closest("p");
  if (paragraph.length) {
    return textContent(paragraph.text()) === normalizedText;
  }

  const host = $(el).parent();
  const hostName = host.length ? (host[0].name || "").toLowerCase() : "";
  if (
    FLOW_CONTENT_HOSTS.has(hostName) &&
    textContent(host.text()) === normalizedText
  ) {
    return true;
  }

  return false;
}

function normalizeLayout(layout) {
  if (!layout || typeof layout !== "string") return DEFAULT_LAYOUT;
  const normalized = layout.toLowerCase();
  return VALID_LAYOUTS.has(normalized) ? normalized : DEFAULT_LAYOUT;
}

function buildImageMarkup(metadata, layout) {
  const imageSet = metadata.imageSet;
  const src = metadata.image;

  if (!src) return "";

  const attrs = [`src="${escapeAttribute(src)}"`, 'alt=""', 'loading="lazy"'];

  const width = getPrimaryImageDimension(metadata, "width");
  const height = getPrimaryImageDimension(metadata, "height");

  if (width && height) {
    attrs.push(`width="${width}"`, `height="${height}"`);
  }

  if (imageSet && imageSet.srcset) {
    attrs.push(`srcset="${escapeAttribute(imageSet.srcset)}"`);
    const sizes =
      layout === "large"
        ? "(max-width: 600px) 100vw, 600px"
        : "(max-width: 600px) 100vw, 96px";
    attrs.push(`sizes="${escapeAttribute(sizes)}"`);
  }

  return `<img ${attrs.join(" ")}>`;
}

function getPrimaryImageDimension(metadata, dimension) {
  if (!metadata) return null;

  const value = Number(metadata[`image${capitalize(dimension)}`]);
  if (Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }

  if (
    metadata.imageSet &&
    Array.isArray(metadata.imageSet.items) &&
    metadata.imageSet.items.length
  ) {
    const items = metadata.imageSet.items.slice().sort((a, b) => a.width - b.width);
    const target = items[items.length - 1];
    if (target) {
      const numeric = Number(target[dimension]);
      if (Number.isFinite(numeric) && numeric > 0) {
        return Math.round(numeric);
      }
    }
  }

  return null;
}

function capitalize(value) {
  if (!value || typeof value !== "string") return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function buildIconMarkup(metadata) {
  const icon = metadata.icon;

  if (!icon) return "";

  return `<img class="link-card__icon" src="${escapeAttribute(icon)}" alt="">`;
}

function buildURLMarkup(displayURL, iconMarkup) {
  const content = [];

  if (iconMarkup) {
    content.push(iconMarkup);
  }

  const text = escapeHTML(displayURL);
  if (text) {
    content.push(`<span class="link-card__url-text">${text}</span>`);
  }

  if (content.length === 0) {
    return "";
  }

  return `<span class="link-card__url">${content.join("")}</span>`;
}

function isExternal(href, options) {
  try {
    const url = new URL(href);
    if (!url.hostname) return false;

    const ignored = new Set();

    if (options.domain) {
      try {
        ignored.add(new URL(options.domain).hostname || options.domain);
      } catch (err) {
        ignored.add(options.domain);
      }
    }

    if (options.baseURL) {
      try {
        ignored.add(new URL(options.baseURL).hostname);
      } catch (err) {}
    }

    return !ignored.has(url.hostname);
  } catch (err) {
    return false;
  }
}

function textContent(str) {
  return (str || "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function formatDisplayURL(href) {
  try {
    const url = new URL(href);
    const hostname = url.hostname;
    const hostnameWithoutLeadingWWW = hostname.startsWith('www.') ? hostname.slice('www.'.length) : hostname;
    return hostnameWithoutLeadingWWW;
  } catch (err) {
    return href;
  }
}

function escapeHTML(str) {
  return he.encode(String(str || ""), {
    useNamedReferences: true,
  });
}

function escapeAttribute(str) {
  return he
    .encode(String(str || ""), {
      useNamedReferences: true,
    })
    .replace(/"/g, "&quot;");
}

module.exports = {
  buildCardHTML,
  replaceWithCard,
  shouldTransform,
  normalizeLayout,
};
