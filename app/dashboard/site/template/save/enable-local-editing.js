const Template = require("models/template");

// Turns on local editing and writes the template's files into the blog's
// folder. If the folder write fails (for example a revoked Dropbox token),
// the files already written are removed and local editing is switched back
// off, so the next sync doesn't import a partial template, and the error goes
// to the dashboard instead of claiming the template was moved.
module.exports = function enableLocalEditing(req, res, next) {
  Template.setMetadata(
    req.template.id,
    { localEditing: true },
    function (err) {
      if (err) return next(err);

      // Respond once the files are written, so the folder lock taken for
      // this request is held until then.
      Template.writeToFolder(req.blog.id, req.template.id, function (err) {
        if (err) {
          // removeFromFolder only acts while localEditing is true, so it
          // runs before the flag is switched back off. Best effort: the
          // same failure may stop the removal too.
          return Template.removeFromFolder(
            req.blog.id,
            req.template.id,
            function () {
              Template.setMetadata(
                req.template.id,
                { localEditing: false },
                function () {
                  next(err);
                }
              );
            }
          );
        }

        res.message(
          "/sites/" +
            req.blog.handle +
            "/template-folder/" +
            req.template.id.split(":").slice(1).join(":") +
            "/source-code",
          "Moved template to your folder"
        );
      });
    }
  );
};
