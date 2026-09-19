const { callbackify } = require("util");
const screenshot = callbackify(require("helper/screenshot"));
const { join } = require("path");
const config = require("config");
const { v4: uuid } = require("uuid");
const { is } = require("build/converters/webloc");
const SCREENSHOT_DIR = "_bookmark_screenshots";
const SCREENSHOT_WIDTH = 1200;
const SCREENSHOT_HEIGHT = 1200;

function render($, callback, { blogID, path }) {
  if (!is(path)) return callback();

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
    return callback();
  }

  if (
    (parsedHref.protocol !== "http:" && parsedHref.protocol !== "https:") ||
    parsedHref.username ||
    parsedHref.password
  ) {
    return callback();
  }

  screenshot(
    href,
    localPathToScreenshot,
    // untrusted: href comes from a user-uploaded .webloc/.url file, so this
    // must run in the airlock container - see helper/airlock and
    // config/airlock/README.md. In production helper/screenshot refuses to
    // fall back to a locally-launched Chromium for this.
    { width: SCREENSHOT_WIDTH, height: SCREENSHOT_HEIGHT, untrusted: true },
    function (err) {
      if (err) {
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
