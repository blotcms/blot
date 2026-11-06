const Template = require("models/template");

// Turns on local editing and writes the template's files into the blog's
// folder. If the folder write fails (for example a revoked Dropbox token),
// the files already written are removed and local editing is switched back
// off, so the next sync doesn't import a partial template, and the error goes
// to the dashboard instead of claiming the template was moved.
module.exports = async function enableLocalEditing(req, res, next) {
  try {
    await Template.setMetadata(req.template.id, { localEditing: true });

    // Respond once the files are written, so the folder lock taken for
    // this request is held until then.
    try {
      await Template.writeToFolder(req.blog.id, req.template.id);
    } catch (err) {
      // removeFromFolder only acts while localEditing is true, so it
      // runs before the flag is switched back off. Best effort: the
      // same failure may stop the removal too.
      await Template.removeFromFolder(req.blog.id, req.template.id).catch(
        () => {}
      );
      await Template.setMetadata(req.template.id, {
        localEditing: false,
      }).catch(() => {});
      return next(err);
    }

    res.message(
      "/sites/" +
        req.blog.handle +
        "/template-folder/" +
        req.template.id.split(":").slice(1).join(":") +
        "/source-code",
      "Moved template to your folder"
    );
  } catch (err) {
    next(err);
  }
};
