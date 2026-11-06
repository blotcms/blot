const Template = require("models/template");
const writeChangeToFolder = require("./writeChangeToFolder");
const previewReload = require("helper/publishPreviewReload");
const { isAjaxRequest, sendAjaxResponse } = require("./ajax-response");

async function persistTemplateUpdate(req, res, next) {
  try {
    await Template.update(req.blog.id, req.params.templateSlug, {
      locals: req.locals,
      partials: req.partials,
    });
    await writeChangeToFolder(req.blog, req.template, {});

    // background_color and other locals are package.json metadata. This
    // save writes Redis directly. Preview tabs only reload when this
    // event is published, which folder sync does for file changes.
    previewReload.publish(req.blog.id);

    if (isAjaxRequest(req)) {
      const ajaxOptions = {};
      if (res.locals.templateForked) {
        ajaxOptions.headers = { "X-Template-Forked": "1" };
      }
      return sendAjaxResponse(res, ajaxOptions);
    }

    res.message(req.baseUrl + req.url, "Success!");
  } catch (err) {
    next(err);
  }
}

module.exports = persistTemplateUpdate;
