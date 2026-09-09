// Large, render-only entry fields. These are the only fields retrieve-time
// projection (blog/render/retrieve/helpers/projectEntryFields.js) is ever
// allowed to drop from an entry-list local. parseTemplate records references
// to any of these even through predicate sections and helpers, so a template
// that can render one keeps it.
module.exports = ["html", "body", "teaser", "teaserBody", "summary"];
