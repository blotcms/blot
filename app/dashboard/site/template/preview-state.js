// The state of the preview pane the visitor left it in: which page of the
// site it showed and whether it was set to Desktop or Mobile. The client
// (js/template-editor-preview-iframe.js) keeps it in localStorage and in
// these two cookies, so the server can render the iframe's address, size and
// the toggle right away instead of the script changing them after the first
// paint. The path cookie holds the last template's preview address only.
const PATH_COOKIE = "template-preview-path";
const VIEW_MODE_COOKIE = "template-preview-view-mode";
const MAX_PATH_LENGTH = 512;

const SIZES = {
  desktop: { width: 960, height: 1400 },
  mobile: { width: 390, height: 844 },
};

// The cookie holds the preview origin followed by the path, which must stay
// on that origin
function previewSrc(cookie, previewOrigin) {
  if (typeof cookie !== "string" || cookie.length > MAX_PATH_LENGTH + 200)
    return previewOrigin;
  if (!cookie.startsWith(previewOrigin + "/")) return previewOrigin;
  const path = cookie.slice(previewOrigin.length);
  if (path.startsWith("//") || path.includes("\\")) return previewOrigin;
  if ([...path].some((c) => c.charCodeAt(0) < 32)) return previewOrigin;
  try {
    const url = new URL(path, previewOrigin);
    if (url.origin !== new URL(previewOrigin).origin) return previewOrigin;
    return url.href;
  } catch (e) {
    return previewOrigin;
  }
}

module.exports = (req, res) => {
  const cookies = req.cookies || {};
  const mode = cookies[VIEW_MODE_COOKIE] === "mobile" ? "mobile" : "desktop";
  const mobile = mode === "mobile";

  res.locals.preview = previewSrc(
    cookies[PATH_COOKIE],
    res.locals.previewOrigin
  );
  res.locals.previewWidth = SIZES[mode].width;
  res.locals.previewHeight = SIZES[mode].height;
  res.locals.previewContainerClass = mobile ? "is-mobile" : "";
  res.locals.previewIframeClass = mobile ? "mobile" : "";
  res.locals.previewDesktopSelected = mobile ? "" : "selected";
  res.locals.previewMobileSelected = mobile ? "selected" : "";
  res.locals.previewDesktopPressed = mobile ? "false" : "true";
  res.locals.previewMobilePressed = mobile ? "true" : "false";
};
