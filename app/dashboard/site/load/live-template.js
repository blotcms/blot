const Template = require("models/template");

// The live template's name and editor link, for the overview's summary. The
// metadata read is served by the client-side cache (models/redis-cache).
module.exports = async function (req, res, next) {
  const metadata = await Template.getMetadata(req.blog.template).catch(
    () => null
  );
  const slug = res.locals.template.slug;
  // A template the blog edits in its folder has its own editor URL
  const inFolder =
    metadata && metadata.owner === req.blog.id && metadata.localEditing;

  res.locals.liveTemplate = {
    name: (metadata && metadata.name) || slug,
    url:
      res.locals.base + (inFolder ? "/template-folder/" : "/template/") + slug,
  };

  next();
};
