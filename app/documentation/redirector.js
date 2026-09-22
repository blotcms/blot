const Express = require("express");
const redirector = new Express.Router();

const internal = {
  "/dashboard": "/sites",
  "/account": "/sites/account",
  "/settings": "/sites/default",
  "/log-in": "/sites/log-in",
  "/sign-up": "/sites/sign-up",
  "/notes": "/about/notes",
  "/about/news": "/news",
  "/about/source-code": "/source-code",
  "/help": "/how",
  "/how/drafts": "/how/posts/drafts",
  "/how/pages": "/how/posts/pages",
  "/how/metadata": "/how/posts/metadata",
  "/how/import": "/how/configure/import",
  "/how/configure/import/are.na": "/how/configure/import/arena",
  "/how/configure/import/aredotna": "/how/configure/import/arena",
  "/how/tags": "/how/posts/metadata",
  "/how/files/embedding": "/how/formatting/embedding",
  "/how/files/citations": "/how/formatting/citations",
  "/how/formatting/tex": "/how/formatting/math",
  "/how/files/tex": "/how/formatting/math",
  "/how/files/wikilinks": "/how/formatting/wikilinks",
  "/how/files/layout-tags": "/how/formatting/layout-tags",
  "/how/posts": "/how/files",
  "/about/contact": "/contact",
  "/about/notes/business/unlimited-bandwidth":
    "/about/notes/business/principles",
  "/about/notes/business/technique": "/about/notes/business/tools",
  "/about/notes/programming/technique": "/about/notes/programming/tools",
  "/about/notes/design/technique": "/about/notes/design/tools",
  "/about/notes/business/project-management": "/about/notes/business/tools",
  "/about/notes/design/aesthetic": "/about/notes/design/principles",
  "/about/notes/design/irritating-websites": "/about/notes/design/principles",
  "/updates": "/news",
  "/developers/support": "/contact",
  "/source": "/about/source-code",
  "/metadata": "/how/posts/metadata",
  "/publishing": "/how",
  "/404s": "/how/configure/redirects",
  "/howto": "/how",
  "/support": "/contact",
  "/templates/diary": "/templates/blog",
  "/templates/essay": "/templates/portfolio",
  "/templates/picture": "/templates/photo",
  "/templates/scrapbook": "/templates/reference",
  "/templates/for-blogging": "/templates/for-writing",
  "/templates/for-organizations": "/templates/for-design",
  "/templates/for-editorial": "/templates/for-writing",
  "/templates/for-notes": "/templates/for-research",
  "/templates/for-documentation": "/templates/for-research",
  // Categories retired when Templates was realigned to mirror the
  // Examples audience filters (Writing/Art/Research/Photography/Design).
  "/templates/for-portfolio": "/templates/for-design",
  "/templates/for-publication": "/templates/for-writing",
  "/templates/for-archive": "/templates/for-photography",
  "/templates/for-personal": "/templates",
  "/templates/for-organization": "/templates/for-design",
  "/templates/developers/guides": "/developers/guides",
  "/templates/developers/reference/blog": "/developers/reference",
  "/templates/developers/reference/lists": "/developers/reference",
  "/templates/developers/reference/helper-functions": "/developers/reference",
  "/templates/developers/reference/entry": "/developers/reference",
  "/templates/developers/reference/date-tokens": "/developers/reference",
  "/templates/developers/rendering-templates":
    "/developers/guides/how-blot-works",
  "/templates/developers/how-blot-works":
    "/developers/guides/how-blot-works",
  "/about/notes/programming/development-environment":
    "/developers/guides/set-up-development-environment",
  "/how/templates": "/templates",
  "/how/dates": "/how/posts/metadata",
  "/developers/dashboard-controls": "/developers/guides/dashboard-controls",
  "/developers/documentation": "/developers",
  "/templates/developers/tutorials/json-feed": "/developers/guides",
  "/developers/tutorials": "/developers/guides",
  "/developers/tutorials/mustache": "/developers/guides/mustache",
  "/developers/tutorials/custom-metadata": "/developers/guides/custom-metadata",
  "/developers/tutorials/thumbnails": "/developers/guides/thumbnails",
  "/developers/tutorials/dashboard-controls": "/developers/guides/dashboard-controls",
  "/developers/tutorials/seo-social-meta-tags": "/developers/guides/seo-social-meta-tags",
  "/developers/tutorials/how-blot-works": "/developers/guides/how-blot-works",
  "/developers/tutorials/convert-jekyll-template": "/developers/guides/convert-jekyll-template",
  "/developers/tutorials/convert-jekyll-template/converting-jekyll-theme":
    "/developers/guides/convert-jekyll-template/converting-jekyll-theme",
  "/developers/tutorials/set-up-development-environment":
    "/developers/guides/set-up-development-environment",
  "/developers/guides/set-up-development-environment": 
    "/developers/guides/run-blot-locally",
  "/templates/developers/tutorials/custom-metadata": "/developers/guides/custom-metadata",
  "/templates/developers": "/developers",
  "/how/guides": "/how/posts",
  "/how/clients": "/how/sync",
  "/how/publishing-with-blot": "/how",
  "/how/configure/urls": "/how/configure/link-format",
  "/how/configuring": "/how/configure",
  "/how/formatting": "/how/guides",
  "/how/format": "/how/posts",
  "/how/posts/tex": "/how/formatting/math",
  "/how/posts/text-and-markdown": "/how/posts/markdown",
  "/how/posts/domain": "/how/configure/domain",
  "/how/posts/comments": "/how/configure/comments",
  "/formatting": "/how/posts",
  "/redirects": "/how/configure/redirects",
  "/configuring": "/how/configure",
  "/tools": "/how/tools"
};

const external = {
  "/typeset": "https://typeset.lllllllllllllllll.com/"
};

Object.keys(internal).forEach(from => {
  redirector.use(from, function (req, res) {
    let to = internal[from];
    let redirect = req.originalUrl.replace(from, to);
    // By default, res.redirect returns a 302 status
    // code (temporary) rather than 301 (permanent)
    res.redirect(301, redirect);
  });
});

Object.keys(external).forEach(from => {
  redirector.use(from, function (req, res) {
    // By default, res.redirect returns a 302 status
    // code (temporary) rather than 301 (permanent)
    res.redirect(301, external[from]);
  });
});

module.exports = redirector;
