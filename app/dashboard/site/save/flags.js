const blogScheme = require("models/blog/scheme");

const flagKeys = Object.keys(blogScheme.TYPE.flags || {});

const normalizeBoolean = (value) =>
  value === true || value === "true" || value === "on" || value === "1";

module.exports = (req, res, next) => {
  const submitted = req.body || {};

  const submittedFlags =
    submitted.flags && typeof submitted.flags === "object"
      ? submitted.flags
      : null;

  // `save.flags` runs for every settings POST; only apply updates when the
  // submitted form actually contains any flag fields.
  const isFlagsRedirect =
    typeof submitted.redirect === "string" &&
    /\/settings\/flags(?:\?|$)/.test(submitted.redirect);

  const hasFlagsSubmission =
    isFlagsRedirect ||
    !!submittedFlags ||
    flagKeys.some(
      (key) =>
        Object.prototype.hasOwnProperty.call(submitted, `flags.${key}`) ||
        Object.prototype.hasOwnProperty.call(submitted, `flags[${key}]`) ||
        Object.prototype.hasOwnProperty.call(submitted, key)
    );

  if (!hasFlagsSubmission) return next();

  const updates = {};

  flagKeys.forEach((key) => {
    const raw =
      (submittedFlags && submittedFlags[key]) ??
      submitted[`flags.${key}`] ??
      submitted[`flags[${key}]`] ??
      submitted[key];
    updates[key] = normalizeBoolean(raw);
  });

  const mergedFlags = {
    ...(req.blog.flags || {}),
    ...updates,
  };

  req.updates = { ...(req.updates || {}), flags: mergedFlags };
  req.body.redirect = req.body.redirect || `${res.locals.base}/settings/flags`;

  next();
};
