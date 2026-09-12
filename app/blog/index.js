const renderView = require("./render/middleware");
const express = require("express");

// This serves the content of users' blogs
const blog = express.Router();

blog.use((req, res, next) => {
  req.log = req.log || console.log;
  res.locals.partials = res.locals.partials || {};
  next();
});

// Custom domain & subdomain middleware
// also handles the mapping of preview domains
blog.use(require("./middleware/vhosts"));

// Load in the rendering engine
blog.use(renderView);

blog.use(require("./middleware/loadTemplate"));

// The order of these routes is important
require("./routes/draft")(blog);
require("./routes/preview-reload")(blog);
require("./routes/tagged")(blog);

blog.get("/search", require("./routes/search"));

require("./routes/robots")(blog);
require("./routes/verify")(blog);

// By checking for entries before template files
// we can allow the user to intercept their site's
// index page on their template with a page whose
// metadata sets 'Link: /`.
blog.use(require("./routes/entry"));
blog.use(require("./routes/view"));

blog.get("/page/:page", require("./routes/entries"));
blog.get("/", require("./routes/entries"));

blog.use(require("./routes/assets"));
blog.use("/random", require("./routes/random"));
require("./routes/error")(blog);

module.exports = blog;
