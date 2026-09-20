// Streams a zip of the template currently installed on a blog to stdout,
// laid out like a template folder (<slug>/package.json, <slug>/style.css...).
//
//   node scripts/template/export-zip <blog ID> > template.zip
//
// Exits with code 3 (and writes nothing to stdout) if the template has
// localEditing enabled, since its files already live in the blog's folder.
// Status messages go to stderr so stdout stays a clean zip stream.

var archiver = require("archiver");
// Blog.get rather than scripts/get/blog, which mints a dashboard login token
var Blog = require("models/blog");
var Template = require("models/template");
var shouldIgnoreFile = require("clients/util/shouldIgnoreFile");

var LOCAL_EDITING_EXIT_CODE = 3;

function fail(message, code) {
  console.error(message);
  process.exit(code || 1);
}

if (!process.argv[2]) fail("Pass a blog identifier (blog ID) as the first argument");

Blog.get({ id: process.argv[2] }, function (err, blog) {
  if (err || !blog) fail(err ? err.message : "No blog " + process.argv[2]);

  if (!blog.template) fail("Blog " + blog.id + " has no template");

  Template.getAllViews(blog.template, function (err, views, metadata) {
    if (err) fail(err.message);
    if (!views || !metadata) fail("No template found for " + blog.template);

    if (metadata.localEditing) {
      console.error(blog.template + " has localEditing enabled");
      process.exit(LOCAL_EDITING_EXIT_CODE);
    }

    var slug = metadata.slug;
    var archive = archiver("zip");

    archive.on("error", function (err) {
      fail(err.message);
    });

    // Exit only once stdout has flushed, or a slow consumer gets a truncated zip
    process.stdout.on("finish", function () {
      process.exit();
    });

    archive.pipe(process.stdout);

    archive.append(Template.package.generate(blog.id, metadata, views), {
      name: slug + "/package.json",
    });

    Object.keys(views).forEach(function (name) {
      var view = views[name];
      if (!view || !view.name || !view.content) return;
      if (shouldIgnoreFile(view.name)) return;
      archive.append(view.content, { name: slug + "/" + view.name });
    });

    archive.finalize();
  });
});
