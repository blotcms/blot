const desnake = require("./util/desnake");

// Text settings. A template lists the string locals it wants editable in
// `text_inputs`, in the order to show them:
//
//   "tagline": "", "address": "", "text_inputs": ["tagline", "address"]
//
// Each becomes a labelled text field in a Details group (controls/text.html),
// saved like any other local. Only listed keys show, so a template's internal
// strings (demo_folder, path_prefix...) never do. `text_input_labels` can
// rename a field: { "founded": "Founded in" }.
module.exports = function (req, res, next) {
  const locals = (req.template && req.template.locals) || {};
  const keys = Array.isArray(locals.text_inputs) ? locals.text_inputs : [];
  const labels =
    locals.text_input_labels && typeof locals.text_input_labels === "object"
      ? locals.text_input_labels
      : {};

  res.locals.text_inputs = keys
    .filter((key) => typeof key === "string" && key)
    .filter(
      (key) => locals[key] === undefined || typeof locals[key] === "string"
    )
    .map((key) => ({
      key,
      label: typeof labels[key] === "string" ? labels[key] : desnake(key),
      value: locals[key] || "",
    }));

  next();
};
