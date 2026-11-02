// The shape of the "mega" sites the benchmark generates. Rounded from the
// blogs whose renders have hurt every other blog on the same process; no
// customer data, only the shape. Sizes are characters of HTML. Each size
// spread is sampled between its percentiles (see content.js), so a run has
// the same long tail every time.
//
// Two different pathologies, so two sites:
//
//   catalog  many small entries and a template whose every page pulls the
//            whole catalog: a head partial iterates {{#archives}} through a
//            partial (so no field projection: every entry keeps its html),
//            a footer partial builds a search index from {{#allEntries}},
//            and every page also lists all tags and two tags' entries.
//            Its owner keeps many templates, so the template editor previews
//            switch between them.
//
//   heavy    few entries, each enormous, on a fork of the stock Hypertext
//            template with a page size of 100: its navigation partial lists
//            {{#posts}} on every page, so the first render after a cacheID
//            bump reads a page of 100 full entries to show their titles, and
//            /archives and /sitemap.xml read the whole catalog to print URLs.
//
// The small sites stand in for everyone else on the process: the victims
// whose latency the contention phase measures.
module.exports = {
  catalog: {
    entries: 1300,
    pages: 30,
    html: { p50: 750, p90: 2100, p99: 10000, max: 200000 },
    teaser: { p50: 600, p90: 1000, p99: 2000, max: 2000 },
    tags: 380,
    tagsPerEntry: { p50: 3, p90: 6, p99: 10, max: 17 },
    // Tag popularity falls off like a power law: the top tag is on about
    // one entry in eight, the median tag on a handful
    tagSkew: 0.6,
    pageSize: 10,
    // Inline CSS and JS the template's partials put on every page
    inlineStyleChars: 150000,
    inlineScriptChars: 60000,
    previewTemplates: 6,
    years: 20,
  },

  heavy: {
    entries: 230,
    pages: 1,
    html: { p50: 120000, p90: 570000, p99: 1600000, max: 2800000 },
    teaser: { p50: 600, p90: 1200, p99: 2700, max: 2700 },
    tags: 0,
    pageSize: 100,
    sortBy: "id",
    previewTemplates: 2,
    years: 2,
  },

  small: {
    sites: 4,
    entries: 60,
    html: { p50: 3000, p90: 8000, p99: 20000, max: 30000 },
    teaser: { p50: 600, p90: 1000, p99: 1500, max: 1500 },
    tags: 12,
    tagsPerEntry: { p50: 1, p90: 3, p99: 4, max: 4 },
    tagSkew: 1,
    years: 3,
  },
};
