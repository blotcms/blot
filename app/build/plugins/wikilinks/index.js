const { tryEach, eachOf } = require("async");
const path = require("path");
const { resolve, dirname, extname } = path;
const byPath = require("./byPath");
const byFilename = require("./byFilename");
const byURL = require("./byURL");
const byTitle = require("./byTitle");
const byHeadingAnchor = require("./byHeadingAnchor");
const { decode } = require("he");
const makeSlug = require("helper/makeSlug");
const debug = require("debug")("blot:entry:build:plugins:wikilinks");

const basename = (path.posix || path).basename;


// Helper function to check if a path is a markdown/text file
function isMarkdownFile(path) {
  if (!path) return false;
  const ext = extname(path).toLowerCase();
  return [".txt", ".text", ".md", ".markdown"].indexOf(ext) > -1;
}


function render($, callback, { blogID, path }) {
  const cleanupWikilinkMarker = ($node, { removeClass = false } = {}) => {
    if (!$node || !$node.length) return;

    if ($node.attr("data-wikilink-marker") === "1") {
      const title = ($node.attr("title") || "").toLowerCase();
      if (title === "wikilink") {
        $node.removeAttr("title");
      }
      $node.removeAttr("data-wikilink-marker");
    }

    if (!removeClass) return;

    const existingClasses = ($node.attr("class") || "")
      .split(/\s+/)
      .filter((className) => className && className !== "wikilink");

    if (existingClasses.length) {
      $node.attr("class", existingClasses.join(" "));
    } else {
      $node.removeAttr("class");
    }
  };

  const legacyWikilinks = $("[title='wikilink']");

  legacyWikilinks.each(function (_, node) {
    const $node = $(node);
    const isLink = node && node.name === "a";
    const isMedia = !isLink && $node.attr("src") !== undefined;

    if (!isLink && !isMedia) {
      return;
    }

    const existingClasses = ($node.attr("class") || "")
      .split(/\s+/)
      .filter(Boolean);

    if (!existingClasses.includes("wikilink")) {
      existingClasses.push("wikilink");
      $node.attr("class", existingClasses.join(" "));
    }

    $node.attr("data-wikilink-marker", "1");

    if (isLink) {
      $node.removeAttr("title");
    }
  });

  const wikilinks = $(".wikilink[data-wikilink-marker='1']");
  let dependencies = [];
  const titles = byTitle.titleIndex(blogID);

  eachOf(
    wikilinks,
    function (node, i, next) {
      if (!node || !node.name) {
        debug("Skipping invalid wikilink node");
        return next();
      }

      const $node = $(node);
      const isLink = node.name === "a";
      const mediaSource = $node.attr("src");
      const isMedia = !isLink && mediaSource !== undefined;

      if (!isLink && !isMedia) {
        debug("Skipping non-link, non-media wikilink node");
        return next();
      }


      const attribute = isLink ? "href" : "src";
      const rawTarget = isLink ? $node.attr(attribute) : mediaSource;

      if (!rawTarget) {
        cleanupWikilinkMarker($node, { removeClass: isMedia });
        debug("Skipping wikilink node with no target");
        return next();
      }

      // Pandoc encodes certain characters in the
      // wikilink as HTML entities, e.g.
      // "Hello's" to "Hello&#39;s"
      // This library will decode HTML entities (HE)
      // for us, hopefully safely
      const href = decode(rawTarget);

      debug("Processing wikilink node:", href, isLink ? "[link]" : "[media]");

      // Rougly compare the href and text contents of the link
      // if they don't match the user did something like this:
      // [[target|Title here]]
      const piped = isLink && makeSlug($node.html()) !== makeSlug(href);

      const lookups = [
        byPath.bind(null, blogID, path, href, isLink),
        byFilename.bind(null, blogID, path, href, isLink),
        byURL.bind(null, blogID, href),
        byTitle.bind(null, titles, href),
        byHeadingAnchor.bind(null, $, href),
      ];

      tryEach(lookups, function (err, result) {
        if (err || !result || !result.url) {
          // we failed to find a path, we should register paths to watch
          // if pathOfPost is '/Posts/foo.txt' then dirOfPost is '/Posts'
          const dirOfPost = dirname(path);

          // if href is 'sub/Foo.txt' and dirOfPost is '/Posts' then
          // resolvedHref is '/Posts/sub/Foo.txt'
          const resolvedHref = resolve(dirOfPost, href);

          const strippedHref = href.split("|")[0].trim();
          const sanitizedHref = strippedHref.split(/[?#]/)[0];

          const pathsToWatch = [
            resolvedHref,
            resolvedHref + ".md",
            resolvedHref + ".txt",
          ];

          const slugToken = makeSlug(strippedHref);
          const filenameToken = basename(sanitizedHref || strippedHref);

          const syntheticDependencies = [];

          if (slugToken) {
            syntheticDependencies.push(`/__wikilink_slug__/${slugToken}`);
          }

          if (filenameToken) {
            syntheticDependencies.push(`/__wikilink_filename__/${filenameToken}`);
          }

          pathsToWatch
            .concat(syntheticDependencies)
            .forEach((path) => {
              if (path && !dependencies.includes(path)) dependencies.push(path);
            });

          // For unresolved links, still rewrite display text to basename for absolute paths
          const isUnresolvedAbsolutePath = strippedHref.startsWith("/");

          if (isLink && !piped && isUnresolvedAbsolutePath) {
            const displayTitle = filenameToken || strippedHref;
            if (displayTitle) {
              const withoutExt = extname(displayTitle)
                ? displayTitle.slice(0, -extname(displayTitle).length)
                : displayTitle;
              $node.text(withoutExt || displayTitle);
            }
          }

          cleanupWikilinkMarker($node, { removeClass: isMedia });

          debug("Wikilink target not found for", href);
          return next();
        }

        const { url, title, path: linkedPath } = result;

        if (isLink) {
          debug("Setting link href to", url);
          $node.attr("href", url);
          if (!piped) {
            debug("Setting link text to", title || url);
            $node.text(title || url);
          }
        } else {
          if (isMarkdownFile(linkedPath)) {
            const { get } = require("models/entry");

            return get(blogID, linkedPath, function (entry) {
              if (!entry) {
                debug(
                  "No entry found for markdown media target, falling back to src",
                  url || linkedPath
                );
                $node.attr("src", url || linkedPath);
                cleanupWikilinkMarker($node, { removeClass: isMedia });
                return next();
              }

              const html = entry && entry.html ? entry.html : "";
              const embedded = $("<div class='embedded-markdown'></div>");
              embedded.html(html);
              
              // if embedded has an h1 with a class of injected-title, remove it
              // this is a hack to remove the injected title from the embedded markdown
              const injectedTitle = embedded.find("h1.injected-title");
              
              if (injectedTitle && injectedTitle.length) {
                injectedTitle.remove();
              }

              $node.replaceWith(embedded);

              if (linkedPath && !dependencies.includes(linkedPath)) {
                debug("Adding dependency on", linkedPath);
                dependencies.push(linkedPath);
              }

              return next();
            });
          }

          debug("Setting media src to", url);
          $node.attr("src", linkedPath);

          // if the node is an image, replace the title text with the alt text
          // if the title text is 'wikilink' (which is what pandoc sets it to)
          const altText = $node.attr("alt");
          if (altText && altText.toLowerCase() !== "wikilink") {
            debug("Setting image title to", altText);
            $node.attr("title", altText);
          }

          // if the node is an image and the next node is a span class=caption
          // then we set the caption text to the alt text
          const nextNode = $node.next();
          if (
            nextNode &&
            nextNode.length &&
            nextNode[0].name === "span" &&
            nextNode.attr("class") === "caption" &&
            nextNode.text().trim() === "wikilink"
          ) {
            debug("Setting image caption to", altText);
            nextNode.text(altText || "");
          }

          cleanupWikilinkMarker($node, { removeClass: isMedia });
        }

        if (isLink) {
          cleanupWikilinkMarker($node);
        }

        if (linkedPath) {
          debug("Adding dependency on", linkedPath);
          dependencies.push(linkedPath);
        }

        next();
      });
    },
    function () {
      callback(null, { newDependencies: dependencies });
    }
  );
}
module.exports = {
  render,
  category: "links",
  title: "Wikilinks",
  description: "Convert wikilinks to standard links",
  first: true,
};
