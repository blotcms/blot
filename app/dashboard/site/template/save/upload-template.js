const cleanupFiles = require("./cleanup-files");
const collectUploadEntries = require("./collect-upload-entries");
const parseUploadedTemplate = require("./parse-uploaded-template");
const createTemplateFromUpload = require("./create-template-from-upload");

const escapeHTML = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Creates a new template from a folder or zip file the user dropped on the
// 'New template' page.
//
// The template is created but never installed: switching the live site is a
// separate, deliberate step on the template's settings page. Nothing about
// the upload can decide it, including package.json's 'enabled'.

module.exports = async function uploadTemplate (req, res) {
  try {
    const { entries, fallbackName } = await collectUploadEntries(req);

    const { name, locals, views, ignored, warnings } = parseUploadedTemplate(
      entries,
      { fallbackName }
    );

    // Nothing below needs the temporary files, and creating a template makes
    // enough Redis writes to be worth not holding disk through them
    await cleanupFiles(req.files);

    const template = await createTemplateFromUpload({
      owner: req.blog.id,
      name,
      locals,
      views,
    });

    const slug = template.id.split(":").slice(1).join(":");

    const redirect = `/sites/${req.blog.handle}/template/${slug}`;

    // Shown by the message middleware above the new template's page, along
    // with any warnings, once the client follows the redirect. The text is
    // rendered unescaped, so the name has to be escaped here.
    req.session.message = {
      text: `Created ${escapeHTML(template.name)}.`,
      error: false,
      url: redirect,
      warnings,
    };

    return res.json({
      ok: true,
      name: template.name,
      redirect,
      views: views.map((view) => view.name),
      ignored,
      warnings,
    });
  } catch (err) {
    if (err && err.problems) {
      return res.status(err.status || 422).json({
        error: err.message,
        problems: err.problems,
      });
    }

    if (err && err.code === "EEXISTS") {
      return res.status(409).json({ error: err.message });
    }

    if (err && err.status === 400) {
      return res.status(400).json({ error: err.message });
    }

    console.error("Template upload failed", req.blog && req.blog.id, err);

    return res.status(500).json({
      error: "Something went wrong creating this template",
    });
  } finally {
    // Multiparty's temporary files are ours to remove, on every path.
    // Removing them twice is harmless: cleanupFiles ignores missing files.
    await cleanupFiles(req.files);
  }
};
