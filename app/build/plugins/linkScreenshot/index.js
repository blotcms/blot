const screenshot = require("helper/screenshot");
const assets = require("storage/assets");
const clfdate = require("helper/clfdate");
const crypto = require("crypto");
const { is } = require("build/converters/webloc");
const { report } = require("build/flags");
const SCREENSHOT_DIR = "_bookmark_screenshots";
const SCREENSHOT_WIDTH = 1200;
const SCREENSHOT_HEIGHT = 1200;

// A link's screenshot lives at a path made from its URL, so a rebuild of a
// bookmark post finds the one an earlier build took and links it again,
// rather than taking another into a new file, which left every earlier one
// in the bucket. A screenshot is taken only while there's none at the path:
// for a new link, or once the file has been deleted, which purges its CDN
// URL, so the new bytes never meet a stale cached copy.
function screenshotPathFor(href) {
  const name = crypto.createHash("sha256").update(href).digest("hex");
  return SCREENSHOT_DIR + "/" + name.slice(0, 32) + ".png";
}

// Whether the screenshot is in the bucket. If S3 can't say, one is taken:
// at worst it replaces the file with a newer screenshot of the same page.
async function taken(blogID, screenshotPath) {
  try {
    return await assets.exists(blogID, screenshotPath);
  } catch (err) {
    console.log(
      clfdate(),
      "[linkScreenshot] checking for a screenshot failed",
      "blog=" + blogID,
      "path=" + screenshotPath,
      err.message
    );
    return false;
  }
}

function wrap($, href, caption, src) {
  $.root().html(
    `<p class="bookmark-container">
        <a class="bookmark-screenshot" href="${href}">
          <img width="${SCREENSHOT_WIDTH}" height="${SCREENSHOT_HEIGHT}" src="${src}" title="Screenshot of ${caption}" />
        </a>
        <a class="bookmark" href="${href}">${caption}</a>
       </p>`
  );
}

async function render($, { blogID, path }) {
  if (!is(path)) return;

  const link = $("p a.bookmark").first();
  const href = link.attr("href");
  const caption = link.html();

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

  const screenshotPath = screenshotPathFor(href);
  const src = assets.url(blogID, screenshotPath);

  if (await taken(blogID, screenshotPath)) return wrap($, href, caption, src);

  const localPathToScreenshot = assets.path(blogID, screenshotPath);

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
    report({ code: "SCREENSHOT_FAILED", target: href });
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

  wrap($, href, caption, src);
}

module.exports = {
  render,
  isDefault: true,
  category: "images",
  description: "Add screenshots to bookmark file posts",
};
