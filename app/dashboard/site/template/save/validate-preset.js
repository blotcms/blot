const savePreset = require("./preset");
const { isAjaxRequest, sendAjaxResponse } = require("./ajax-response");

// Resolve the request while it still references the source template. This
// keeps rejected preset requests from forking a stock template first.
module.exports = function validatePreset(req, res, next) {
  const result = savePreset.resolve(req);

  if (result.error) {
    const err = new Error(result.error);
    err.status = 400;
    if (isAjaxRequest(req)) {
      return sendAjaxResponse(res, { status: 400, body: result.error });
    }
    return next(err);
  }

  req.resolvedPreset = result;
  next();
};
