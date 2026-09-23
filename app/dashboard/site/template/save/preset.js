const applyResolvedPreset = require("../presets").applyResolvedPreset;
const { isAjaxRequest, sendAjaxResponse } = require("./ajax-response");

function requestedPreset(req) {
  const body = req.body || {};
  const nested = body.preset && typeof body.preset === "object" ? body.preset : {};
  const type = body["preset.type"] || nested.type;
  const id = body["preset.id"] || nested.id;
  return { type, id };
}

function resolvePreset(req) {
  const { type, id } = requestedPreset(req);
  return applyResolvedPreset(req.template, type, id);
}

// preset.type and preset.id are resolved against the template package.
// The browser does not send the preset's values.
function savePreset(req, res, next) {
  const result = req.resolvedPreset || resolvePreset(req);

  if (result.error) {
    const err = new Error(result.error);
    err.status = 400;
    if (isAjaxRequest(req)) {
      return sendAjaxResponse(res, { status: 400, body: result.error });
    }
    return next(err);
  }

  req.locals = result.locals;
  req.partials = (req.template && req.template.partials) || {};
  next();
}

savePreset.resolve = resolvePreset;

module.exports = savePreset;
