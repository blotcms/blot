const Entry = require("models/entry");
const fetchTaggedEntries = require("./helpers/fetchTaggedEntries");
const projectEntryFields = require("./helpers/projectEntryFields");
const getTemplateSortOptions = require("blog/sortOptions");
const { sortEntries } = getTemplateSortOptions;

module.exports = function (req, res, callback) {
  const blogID = req.blog.id;
  const tags =
    req.query.name ||
    req.query.tag ||
    req.params.tag ||
    (res.locals && res.locals.tag) ||
    "";

  let page = parseInt(req.params.page, 10);
  if (!page || page < 1) page = 1;

  const templateLocals = (req.template && req.template.locals) || {};
  const pathPrefix =
    (res.locals && res.locals.path_prefix) ?? templateLocals.path_prefix;
  const sortOptions = getTemplateSortOptions(templateLocals);

  let preferredLimit;

  if (templateLocals.tagged_page_size !== undefined) {
    preferredLimit = templateLocals.tagged_page_size;
  } else {
    preferredLimit = templateLocals.page_size;
  }

  let limit = parseInt(preferredLimit, 10);
  if (!Number.isFinite(limit)) limit = undefined;

  if (!limit || limit < 1 || limit > 500) limit = 100;

  const offset = (page - 1) * limit;

  fetchTaggedEntries(
    blogID,
    tags,
    { limit, offset, pathPrefix, ...sortOptions },
    function (err, result) {
      if (err) return callback(err);

      Entry.get(blogID, result.entryIDs || [], function (entries) {
        entries = sortEntries(entries, sortOptions);

        projectEntryFields(entries, req.retrieve, ["tagged"]);

        const totalEntries =
          result.total !== undefined
            ? result.total
            : (result.entryIDs || []).length;

        res.locals.pagination = res.locals.pagination || result.pagination || {};

        callback(null, {
          tag: result.tag,
          tagged: result.tagged,
          is: result.tagged, // alias
          entries,
          pagination: result.pagination,
          total: totalEntries,
          entryIDs: result.entryIDs || [],
          slugs: result.slugs,
          prettyTags: result.prettyTags,
        });
      });
    }
  );
};
