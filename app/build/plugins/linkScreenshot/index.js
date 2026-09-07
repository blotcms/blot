const { callbackify } = require("util");
const screenshot = callbackify(require("helper/screenshot"));
const { join } = require("path");
const config = require("config");
const uuid = require("uuid/v4");
const { is } = require("build/converters/webloc");
const clfdate = require("helper/clfdate");
const SCREENSHOT_DIR = "_bookmark_screenshots";
const SCREENSHOT_WIDTH = 1200;
const SCREENSHOT_HEIGHT = 1200;

function render($, callback, { blogID, path }) {
  if (!is(path)) return callback();

  const prefix = () => clfdate() + "linkScreenshot: ";

  const link = $("p a.bookmark").first();
  const href = link.attr("href");
  const caption = link.html();
  const pathToScreenshot = join(blogID, SCREENSHOT_DIR, uuid() + ".png");
  const localPathToScreenshot = join(
    config.blog_static_files_dir,
    pathToScreenshot
  );

  const src = config.cdn.origin + "/" + pathToScreenshot;

  if (!href) {
    console.log(prefix(), "No HREF");
    return callback();
  }

  // Only ever screenshot a plain public http(s) URL. Credentials in the URL
  // are a common trick for slipping an internal host past a naive check.
  // Destination IP filtering (private ranges, cloud metadata, rebinding) is
  // enforced in the airlock container - see config/airlock.
  let parsedHref;
  try {
    parsedHref = new URL(href);
  } catch (e) {
    console.log(prefix(), "Invalid HREF");
    return callback();
  }

  if (
    (parsedHref.protocol !== "http:" && parsedHref.protocol !== "https:") ||
    parsedHref.username ||
    parsedHref.password
  ) {
    // Log the origin/protocol only - never the full href here, since this
    // branch is reached precisely when the URL may carry credentials.
    console.log(
      prefix(),
      "Refusing to screenshot non-public HREF",
      parsedHref.protocol,
      parsedHref.host
    );
    return callback();
  }

  screenshot(
    href,
    localPathToScreenshot,
    { width: SCREENSHOT_WIDTH, height: SCREENSHOT_HEIGHT },
    function (err) {
      if (err) {
        console.log(prefix(), "Error fetching screenshot", err);
        return callback();
      }

      $.root().html(
        `<p class="bookmark-container">
        <a class="bookmark-screenshot" href="${href}">
          <img width="${SCREENSHOT_WIDTH}" height="${SCREENSHOT_HEIGHT}" src="${src}" title="Screenshot of ${caption}" />
        </a>
        <a class="bookmark" href="${href}">${caption}</a>
       </p>`
      );

      console.log(prefix(), "Valid screenshot", href, src);
      return callback();
    }
  );
}

module.exports = {
  render,
  isDefault: true,
  category: "images",
  description: "Add screenshots to bookmark file posts",
};
