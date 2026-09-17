const ensure = require("helper/ensure");

const all_entries = require("./all_entries");
const all_tags = require("./all_tags");
const recent_entries = require("./recent_entries");
const latest_entry = require("./latest_entry");
const is_active = require("./is_active");
const absolute_urls = require("./absolute_urls");
const encode_json = require("./encode_json");
const encode_xml = require("./encode_xml");
const encode_uri_component = require("./encode_uri_component");
const app_css = require("./app_css");
const app_js = require("./app_js");

const dictionary = {
  absolute_urls: absolute_urls,
  absoluteURLs: absolute_urls,
  active: require("./active"),
  all_entries: all_entries,
  allEntries: all_entries,
  all_tags: all_tags,
  allTags: all_tags,
  app_css: app_css,
  appCSS: app_css,
  app_js: app_js,
  appJS: app_js,
  archives: require("./archives"),
  asset: require("./asset"),
  avatar_url: require("./avatar_url"),
  cdn: require("./cdn"),
  css_url: require("./css_url"),
  encode_json: encode_json,
  encodeJSON: encode_json,
  encode_uri_component: encode_uri_component,
  encodeURIComponent: encode_uri_component,
  encode_xml: encode_xml,
  encodeXML: encode_xml,
  feed_url: require("./feed_url"),
  folder: require("./folder"),
  is: require("./is"),
  is_active: is_active,
  isActive: is_active,
  latest_entry: latest_entry,
  latestEntry: latest_entry,
  plugin: require("./plugin"),
  plugin_css: app_css,
  plugin_js: app_js,
  popular_tags: require("./popular_tags"),
  posts: require("./posts"),
  recent_entries: recent_entries,
  recentEntries: recent_entries,
  rgb: require("./rgb"),
  script_url: require("./script_url"),
  search_query: require("./search_query"),
  search_results: require("./search_results"),
  tagged: require("./tagged"),
  total_posts: require("./total_posts"),
  updated: require("./updated"),
};

module.exports = async function retrieve(req, res, needed) {
  ensure(req, "object").and(needed, "object");

  const locals = {};
  req.retrieve = needed;

  await Promise.all(
    Object.keys(needed).map(async (localName) => {
      if (dictionary[localName] === undefined) {
        return;
      }

      req.log("Retrieving local", localName);

      try {
        const value = await dictionary[localName](req, res);
        if (value !== undefined) locals[localName] = value;
      } catch (err) {
        // getPage rejects invalid :page with statusCode 400. Listing views
        // retrieve posts inside renderView, so that error must surface.
        if (err && err.statusCode) throw err;
        // Known trade-off: /, /tagged/:tag and /search used to have their
        // own try/catch -> next(err), so any fetch error (a Redis hiccup in
        // fetchTaggedEntries/Entry.get, a bug in Entry.search, ...) rendered
        // the error.html page. Now that those routes fetch through the same
        // retrieve pass as every other local, an error here without a
        // statusCode is just logged and the page renders as if that local
        // were empty - a 200 with a missing/empty listing instead of an
        // error page. Accepted for now; revisit if this masks real
        // incidents. See PR #1886.
        console.log(err);
      }

      req.log("Retrieved local", localName);
    })
  );

  req.log("Retrieved all locals");
  return locals;
};

// Every name (canonical + alias) blot knows how to fetch. Exposed so
// models/template can tell a real retrieve dependency from stale metadata.
module.exports.dictionary = dictionary;
