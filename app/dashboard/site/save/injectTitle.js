module.exports = function (req, res, next) {
  const updates =
    req.updates && req.updates.plugins && req.updates.plugins.injectTitle;
  if (!updates) return next();

  const options = updates.options || (updates.options = {});
  const previous = (req.blog.plugins && req.blog.plugins.injectTitle) || {};
  const previousOptions = previous.options || {};

  let manuallyDisabled = previousOptions.manuallyDisabled;

  if (manuallyDisabled === "true") manuallyDisabled = true;
  if (manuallyDisabled === "false") manuallyDisabled = false;

  const wasEnabled = !!previous.enabled;
  const isEnabled = !!updates.enabled;

  if (!isEnabled && wasEnabled) {
    manuallyDisabled = true;
  } else if (isEnabled) {
    manuallyDisabled = false;
  }

  if (manuallyDisabled === undefined) manuallyDisabled = false;

  options.manuallyDisabled = manuallyDisabled;

  next();
};
