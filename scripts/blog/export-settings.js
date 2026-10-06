// Prints a blog's portable settings (permalink, timeZone, dateFormat,
// plugins, menu, converters...) as JSON so they can be applied to a copy of
// the site elsewhere, e.g. by `npm run fork`. Environment-specific fields
// (handle, domain, client, template, SSL, status) are left out.
//
//   node scripts/blog/export-settings <blog ID>

// Blog.get rather than scripts/get/blog, which mints a dashboard login token
var Blog = require("models/blog");
var scheme = require("models/blog/scheme");

var EXCLUDED = [
  "handle",
  "domain",
  "client",
  "template",
  "status",
  "forceSSL",
  "redirectSubdomain",
  "isDisabled",
  "flags",
];

if (!process.argv[2]) {
  console.error("Pass a blog identifier (blog ID) as the first argument");
  process.exit(1);
}

Blog.get({ id: process.argv[2] }, function (err, blog) {
  if (err || !blog) {
    console.error(err ? err.message : "No blog " + process.argv[2]);
    return process.exit(1);
  }

  var settings = {};

  scheme.WRITEABLE.forEach(function (key) {
    if (EXCLUDED.indexOf(key) === -1 && blog[key] !== undefined)
      settings[key] = blog[key];
  });

  process.stdout.write(JSON.stringify(settings), function () {
    process.exit();
  });
});
