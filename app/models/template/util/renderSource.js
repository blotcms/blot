// The text a view is rendered from. A view saved on a blog's own template
// carries `resolvedContent` (see util/resolveFolderLinks): its content with
// links to the blog's folder files wrapped in {{#cdn}}. That copy is
// resolved against the owner blog's folder, so it is only used when the blog
// doing the rendering owns the template (template IDs are "<owner>:<slug>");
// anything else, such as a blog still pointing at a SITE template, renders
// the author's content as written. Everything that analyses or edits a
// view - parseTemplate, the dashboard, exports - keeps reading view.content.
module.exports = function renderSource(view, blogID, templateID) {
  if (typeof view.resolvedContent !== "string") return view.content;

  if (
    typeof blogID !== "string" ||
    !blogID ||
    typeof templateID !== "string" ||
    templateID.indexOf(blogID + ":") !== 0
  ) {
    return view.content;
  }

  return view.resolvedContent;
};
