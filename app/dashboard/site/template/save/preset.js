const applyResolvedPreset = require("models/template/presets").applyResolvedPreset;
const { isAjaxRequest, sendAjaxResponse } = require("./ajax-response");

// preset.type and preset.id are resolved against the template package.
// The browser does not send the preset's values.
module.exports = function savePreset(req, res, next) {
  const body = req.body || {};
  const nested = body.preset && typeof body.preset === "object" ? body.preset : {};
  const type = body["preset.type"] || nested.type;
  const id = body["preset.id"] || nested.id;
  const result = applyResolvedPreset(req.template, type, id);

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
};
