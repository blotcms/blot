// Prints a blog's portable settings (permalink, timeZone, dateFormat,
// plugins, menu, converters...) as JSON so they can be applied to a copy of
// the site elsewhere, e.g. by `npm run fork`. Environment-specific fields
// (handle, domain, client, template, SSL, status) are left out.
//
//   node scripts/blog/export-settings <blog identifier>

var getBlog = require("../get/blog");
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
  console.error("Pass a blog identifier as the first argument");
  process.exit(1);
}

getBlog(process.argv[2], function (err, user, blog) {
  if (err) {
    console.error(err.message);
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
