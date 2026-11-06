const makeSlug = require("helper/makeSlug");

module.exports = function byHeadingAnchor($, href, done) {
  const target = normalizeTarget(href);

  if (!target) return done(new Error("Not a heading anchor"));

  const slug = makeSlug(target);

  const resolution =
    findAnchorByIdOrName($, target, slug) ||
    findAnchorByHeadingText($, target, slug) ||
    findAnchorBySlug($, slug);

  if (!resolution) return done(new Error("Not a heading anchor"));

  done(null, {
    url: ensureHash(resolution.anchor),
    path: null,
    title: resolution.title || target,
  });
};

function normalizeTarget(href) {
  if (!href) return null;

  const trimmed = String(href).trim();
  if (!trimmed) return null;

  const withoutHash = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;

  return withoutHash.trim() || null;
}

function ensureHash(anchor) {
  if (!anchor) return "";
  const stripped = stripHash(anchor);
  return "#" + stripped;
}

function stripHash(anchor) {
  if (!anchor) return "";
  return anchor.startsWith("#") ? anchor.slice(1) : anchor;
}

function findAnchorByIdOrName($, value, slug) {
  if (!value && !slug) return null;

  const selectors = [
    { selector: "[id]", attr: "id" },
    { selector: "[name]", attr: "name" },
  ];

  for (const { selector, attr } of selectors) {
    let match = null;

    $(selector).each((_, element) => {
      if (match) return false;

      const attrValue = $(element).attr(attr);
      if (!attrValue) return;

      if (anchorMatches(attrValue, value, slug)) {
        match = {
          anchor: stripHash(attrValue),
          title: findHeadingTextForElement($, element),
        };
        return false;
      }
    });

    if (match) return match;
  }

  return null;
}

function findAnchorByHeadingText($, value, slug) {
  if (!value && !slug) return null;

  let match = null;

  $("h1, h2, h3, h4, h5, h6").each((_, element) => {
    if (match) return false;

    const $heading = $(element);
    const headingText = cleanHeadingText($heading.text());
    const headingSlug = makeSlug(headingText);

    if (
      !headingText ||
      (!matchesText(headingText, value) && headingSlug !== slug)
    ) {
      return;
    }

    const anchor =
      stripHash($heading.attr("id")) ||
      stripHash($heading.attr("name")) ||
      stripHash(findFirstAttribute($, $heading, "id")) ||
      stripHash(findFirstAttribute($, $heading, "name")) ||
      slug;

    if (!anchor) return;

    match = {
      anchor,
      title: headingText,
    };
  });

  return match;
}

function findAnchorBySlug($, slug) {
  if (!slug) return null;

  const selectors = [
    { selector: "[id]", attr: "id" },
    { selector: "[name]", attr: "name" },
  ];

  for (const { selector, attr } of selectors) {
    let match = null;

    $(selector).each((_, element) => {
      if (match) return false;

      const value = $(element).attr(attr);
      if (!value) return;

      if (makeSlug(value) === slug) {
        match = {
          anchor: stripHash(value),
          title: findHeadingTextForElement($, element),
        };
        return false;
      }
    });

    if (match) return match;
  }

  return null;
}

function anchorMatches(anchor, value, slug) {
  if (!anchor) return false;

  const stripped = stripHash(anchor);
  const normalizedAnchor = makeSlug(stripped);
  const normalizedValue = value ? makeSlug(value) : "";
  const compactAnchor = normalizedAnchor.replace(/-/g, "");
  const compactSlug = slug ? slug.replace(/-/g, "") : "";
  const compactValue = normalizedValue.replace(/-/g, "");

  if (value && matchesText(stripped, value)) return true;

  if (slug && normalizedAnchor === slug) return true;
  if (slug && compactAnchor === compactSlug) return true;

  if (value && normalizedAnchor === normalizedValue) return true;
  if (value && compactAnchor === compactValue) return true;

  return false;
}

function matchesText(headingText, value) {
  if (!headingText || !value) return false;
  return cleanHeadingText(headingText) === cleanHeadingText(value);
}

function cleanHeadingText(text) {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim();
}

function findHeadingTextForElement($, element) {
  const $element = $(element);

  if (!$element || !$element.length) return null;

  if (isHeading($element)) return cleanHeadingText($element.text());

  const parents = $element.parents("h1, h2, h3, h4, h5, h6");

  if (parents && parents.length) {
    return cleanHeadingText(parents.first().text());
  }

  return null;
}

function isHeading($element) {
  if (!$element || !$element.length) return false;
  const node = $element[0];
  if (!node || !node.name) return false;
  return /^h[1-6]$/i.test(node.name);
}

function findFirstAttribute($, $element, attribute) {
  if (!$element || !$element.length) return null;

  if ($element.attr(attribute)) return $element.attr(attribute);

  let found = null;

  $element.find(`[${attribute}]`).each((_, node) => {
    if (found) return false;

    const value = $(node).attr(attribute);
    if (value) {
      found = value;
      return false;
    }
  });

  return found;
}
