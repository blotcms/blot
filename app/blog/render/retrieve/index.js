var _ = require("lodash");
var async = require("async");
var ensure = require("helper/ensure");

var all_entries = require("./all_entries");
var all_tags = require("./all_tags");
var recent_entries = require("./recent_entries");
var latest_entry = require("./latest_entry");
var is_active = require("./is_active");
var absolute_urls = require("./absolute_urls");
var encode_json = require("./encode_json");
var encode_xml = require("./encode_xml");
var encode_uri_component = require("./encode_uri_component");
var app_css = require("./app_css");
var app_js = require("./app_js");

var dictionary = {
  "absolute_urls": absolute_urls,
  "absoluteURLs": absolute_urls,
  "active": require("./active"),
  "all_entries": all_entries,
  "allEntries": all_entries,
  "all_tags": all_tags,
  "allTags": all_tags,
  "app_css": app_css,
  "appCSS": app_css,
  "app_js": app_js,
  "appJS": app_js,
  "archives": require("./archives"),
  "asset": require("./asset"),
  "avatar_url": require("./avatar_url"),
  "cdn": require("./cdn"),
  "css_url": require("./css_url"),
  "encode_json": encode_json,
  "encodeJSON": encode_json,
  "encode_uri_component": encode_uri_component,
  "encodeURIComponent": encode_uri_component,
  "encode_xml": encode_xml,
  "encodeXML": encode_xml,
  "feed_url": require("./feed_url"),
  "folder": require("./folder"),
  "is": require("./is"),
  "is_active": is_active,
  "isActive": is_active,
  "latest_entry": latest_entry,
  "latestEntry": latest_entry,
  "plugin": require("./plugin"),
  "plugin_css": app_css,
  "plugin_js": app_js,
  "popular_tags": require("./popular_tags"),
  "posts": require("./posts"),
  "recent_entries": recent_entries,
  "recentEntries": recent_entries,
  "rgb": require("./rgb"),
  "script_url": require("./script_url"),
  "search_query": require("./search_query"),
  "search_results": require("./search_results"),
  "tagged": require("./tagged"),
  "total_posts": require("./total_posts"),
  "updated": require("./updated"),
};

module.exports = function (req, res, retrieve, callback) {
  ensure(req, "object").and(retrieve, "object").and(callback, "function");

  var locals = {};

  req.retrieve = retrieve;

  async.each(
    _.keys(retrieve),
    function (localName, nextLocal) {
      if (dictionary[localName] === undefined) {
        // console.log(req.blog.handle, req.blog.id, ": No retrieve method to look up", localName);
        return nextLocal();
      }

      req.log("Retrieving local", localName);
      dictionary[localName](req, res, function (err, value) {
        if (err) console.log(err);

        if (value !== undefined) locals[localName] = value;

        req.log("Retrieved local", localName);
        return nextLocal();
      });
    },
    function () {
      req.log("Retrieved all locals");
      callback(null, locals);
    }
  );
};

// Every name (canonical + alias) blot knows how to fetch. Exposed so
// models/template can tell a real retrieve dependency from stale metadata.
module.exports.dictionary = dictionary;
