const screenshot = require("helper/screenshot");
const assets = require("storage/assets");
const clfdate = require("helper/clfdate");
const { v4: uuid } = require("uuid");
const { is } = require("build/converters/webloc");
const SCREENSHOT_DIR = "_bookmark_screenshots";
const SCREENSHOT_WIDTH = 1200;
const SCREENSHOT_HEIGHT = 1200;

async function render($, { blogID, path }) {
  if (!is(path)) return;

  const link = $("p a.bookmark").first();
  const href = link.attr("href");
  const caption = link.html();
  const filename = uuid() + ".png";
  const screenshotPath = SCREENSHOT_DIR + "/" + filename;
  const localPathToScreenshot = assets.path(blogID, screenshotPath);

  const src = assets.url(blogID, screenshotPath);

  if (!href) {
    return;
  }

  // Only ever screenshot a plain public http(s) URL. Credentials in the URL
  // are a common trick for slipping an internal host past a naive check.
  // Destination IP filtering (private ranges, cloud metadata, rebinding) is
  // enforced in the sandbox's browser jail - see app/sandbox/README.md.
  let parsedHref;
  try {
    parsedHref = new URL(href);
  } catch (e) {
    return;
  }

  if (
    (parsedHref.protocol !== "http:" && parsedHref.protocol !== "https:") ||
    parsedHref.username ||
    parsedHref.password
  ) {
    return;
  }

  try {
    await screenshot(
      href,
      localPathToScreenshot,
      // untrusted: href comes from a user-uploaded .webloc/.url file, so this
      // must run in the sandbox's browser jail - see app/sandbox/README.md.
      // In production helper/screenshot refuses to
      // fall back to a locally-launched Chromium for this.
      { width: SCREENSHOT_WIDTH, height: SCREENSHOT_HEIGHT, untrusted: true }
    );
  } catch (err) {
    return;
  }

  // The screenshot was written locally by the browser, now it's in place
  try {
    await assets.commit(blogID, screenshotPath);
  } catch (err) {
    console.log(
      clfdate(),
      "[linkScreenshot] commit failed",
      "blog=" + blogID,
      "path=" + screenshotPath,
      err.message
    );
    return;
  }

  $.root().html(
    `<p class="bookmark-container">
        <a class="bookmark-screenshot" href="${href}">
          <img width="${SCREENSHOT_WIDTH}" height="${SCREENSHOT_HEIGHT}" src="${src}" title="Screenshot of ${caption}" />
        </a>
        <a class="bookmark" href="${href}">${caption}</a>
       </p>`
  );
}

module.exports = {
  render,
  isDefault: true,
  category: "images",
  description: "Add screenshots to bookmark file posts",
};
