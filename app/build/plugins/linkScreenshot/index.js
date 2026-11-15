const screenshot = require("helper/screenshot");
const assets = require("storage/assets");
const clfdate = require("helper/clfdate");
const { v4: uuid } = require("uuid");
const { is } = require("build/converters/webloc");
const { report } = require("build/flags");
const client = require("models/client");
const hash = require("helper/hash");
const SCREENSHOT_DIR = "_bookmark_screenshots";
const SCREENSHOT_WIDTH = 1200;
const SCREENSHOT_HEIGHT = 1200;

// The screenshot last taken of each link, per blog: a rebuild of a bookmark
// post reuses it rather than taking another into a new file, which left
// every earlier one in the bucket. Removed with the blog's other keys.
function screenshotKey(blogID, href) {
  return "blog:" + blogID + ":store:screenshots:" + hash(href);
}

// The path of the link's last screenshot, if it is still in the bucket
async function previousScreenshot(blogID, href) {
  try {
    const previous = await client.get(screenshotKey(blogID, href));

    if (previous && (await assets.exists(blogID, previous))) return previous;
  } catch (err) {
    console.log(
      clfdate(),
      "[linkScreenshot] lookup failed",
      "blog=" + blogID,
      err.message
    );
  }

  return null;
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

  const previous = await previousScreenshot(blogID, href);

  if (previous) return wrap($, href, caption, assets.url(blogID, previous));

  const screenshotPath = SCREENSHOT_DIR + "/" + uuid() + ".png";
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

  // Only a screenshot in the bucket is remembered. A failure here leaves the
  // next build to take another.
  try {
    await client.set(screenshotKey(blogID, href), screenshotPath);
  } catch (err) {
    console.log(
      clfdate(),
      "[linkScreenshot] remembering screenshot failed",
      "blog=" + blogID,
      err.message
    );
  }

  wrap($, href, caption, assets.url(blogID, screenshotPath));
}

module.exports = {
  render,
  isDefault: true,
  category: "images",
  description: "Add screenshots to bookmark file posts",
};
