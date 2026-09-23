const resolvePreset = require("../presets").resolvePreset;
const { isAjaxRequest, sendAjaxResponse } = require("./ajax-response");

function requestedPreset(req) {
  const body = req.body || {};
  const nested = body.preset && typeof body.preset === "object" ? body.preset : {};
  return {
    type: body["preset.type"] || nested.type,
    id: body["preset.id"] || nested.id,
  };
}

// Resolve against the source template before fork-if-needed runs, then turn
// the compact patch into the same locals.* fields used by normal settings
// forms. The existing merge/save pipeline does the rest.
module.exports = function resolvePresetRequest(req, res, next) {
  const requested = requestedPreset(req);
  if (requested.type === undefined && requested.id === undefined) return next();
  const result = resolvePreset(req.template, requested.type, requested.id);

  if (result.error) {
    const error = new Error(result.error);
    error.status = 400;
    if (isAjaxRequest(req)) {
      return sendAjaxResponse(res, { status: 400, body: result.error });
    }
    return next(error);
  }

  req.body = { ...(req.body || {}) };
  Object.keys(result.values).forEach((key) => {
    const value = result.values[key];
    if (requested.type === "fonts") {
      Object.keys(value).forEach((property) => {
        req.body["locals." + key + "." + property] = value[property];
      });
      return;
    }
    req.body["locals." + key] = value;
  });

  next();
};
