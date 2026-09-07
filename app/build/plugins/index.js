const { marked } = require("marked");
var config = require("config");
var cheerio = require("cheerio");
var fs = require("fs");
var ensure = require("helper/ensure");
var callOnce = require("helper/callOnce");
var extend = require("helper/extend");
var deCamelize = require("helper/deCamelize");
var time = require("helper/time");
var async = require("async");
var _ = require("lodash");
const bluesky = require("./bluesky");

// Wait 10 minutes to go to next plugin
var TIMEOUT = 10 * 60 * 1000;

// Will contain a dictionary
// of every public plugin on
// blog, can be used to render a string
var defaultPlugins = {};

var loaded = loadPlugins({
  analytics: require("./analytics"),
  autoImage: require("./autoImage"),
  bluesky: require("./bluesky"),
  blueskyComments: require("./blueskyComments"),
  codeHighlighting: require("./codeHighlighting"),
  disqus: require("./disqus"),
  externalLinks: require("./externalLinks"),
  flickr: require("./flickr"),
  image: require("./image"),
  imageCaption: require("./imageCaption"),
  injectTitle: require("./injectTitle"),
  katex: require("./katex"),
  linebreaks: require("./linebreaks"),
  mediaPreload: require("./mediaPreload"),
  callouts: require("./callouts"),
  linkScreenshot: require("./linkScreenshot"),
  titlecase: require("./titlecase"),
  twitter: require("./twitter"),
  typeset: require("./typeset"),
  videoEmbeds: require("./videoEmbeds"),
  wikilinks: require("./wikilinks"),
  zoom: require("./zoom")
});

var list = loaded.list;
var plugins = loaded.plugins;
var prerenderers = loaded.prerenderers;

// Takes a string and based on the user's
// plugins converts it into an HTML string
function convert (blog, path, contents, callback) {
  ensure(contents, "string")
    .and(path, "string")
    .and(blog, "object")
    .and(callback, "function");

  var enabled = Enabled(blog.plugins);
  var dependencies = [];

  // This is passed to all plugins
  // I need to change this when we move
  // to HTTPS... Ideally it shouldn't be
  // needed. I'd look up local files on disk...
  var globalOptions = {
    isHTML: isHTML(path),
    domain: blog.domain,
    blogID: blog.id,
    path: path,
    baseURL: "https://" + blog.handle + "." + config.host
  };

  async.eachSeries(
    prerenderers,
    function (plugin, next) {
      var id, blogOptions, options, prerender, timeout;

      id = plugin.id;

      // Only skip this plugin if it's optional
      // and if the user has disabled it.
      if (plugin.optional && !enabled[id]) {
        return next();
      }

      // The options for this plugin are not
      // neccessarily associated with the blog,
      // especially if it is a required plugin
      blogOptions = blog.plugins[id] ? blog.plugins[id].options : {};
      options = {};
      prerender = plugin.prerender;

      extend(options).and(blogOptions).and(globalOptions);

      // We wrap the callback passed to the function
      // to ensure its called once. This allows us
      // to set a timeout safely.
      next = callOnce(next);
      timeout = Timeout(id, next);
      time(id);

      prerender(
        contents,
        function (err, result) {
          time.end(id);
          clearTimeout(timeout);

          if (result && !err) contents = result;

          next();
        },
        options
      );
    },
    function () {
      // Don't decode entities, preserve the original content
      var $ = cheerio.load(contents, { decodeEntities: false }, false);

      async.eachSeries(
        plugins,
        function (plugin, next) {
          var id, options, blogOptions, timeout;

          id = plugin.id;

          if (!plugin.render) return next();

          if (plugin.optional && !enabled[id]) {
            return next();
          }

          options = {};
          blogOptions = blog.plugins[id] ? blog.plugins[id].options : {};

          extend(options).and(blogOptions).and(globalOptions);

          // We wrap the callback passed to the function
          // to ensure its called once. This allows us
          // to set a timeout safely.
          next = callOnce(next);
          timeout = Timeout(id, next);
          time(id);

          // Plugins should call their render callbacks with
          // cb(null, { newDependencies }) to allow us to extend
          // the result object with future fields (e.g. toc).
          plugin.render(
            $,
            function (err, result) {
              time.end(id);

              const res = Array.isArray(result) ? { newDependencies: result } : result || {};

              if (res.newDependencies) {
                dependencies = dependencies.concat(res.newDependencies);
              }

              clearTimeout(timeout);
              next();
            },
            options
          );
        },
        function () {
          // Return the entry's completed HTML
          // pass the HTML so it can be rendered totally tast
          callback(null, $.html(), dependencies);
        }
      );
    }
  );
}

// Load plugin templates,
// this is currently async but uses
// a callback for when I need it
function load (file, blogPlugins, callback) {
  var response = "";

  for (var i in blogPlugins) {
    if (blogPlugins[i].enabled && list[i]) {
      if (file === "entryHTML" && list[i].entryHTML)
        response += list[i].entryHTML || "";

      if (file === "css" && list[i].publicCSS)
        response += list[i].publicCSS || "";

      if (file === "js" && list[i].publicJS) response += list[i].publicJS || "";
    }
  }

  return callback(null, response);
}

function Enabled (blogPlugins) {
  var enabled = {};

  for (var i in blogPlugins) if (blogPlugins[i].enabled) enabled[i] = true;

  return enabled;
}

function isHTML (path) {
  return path.slice(-5) === ".html" || path.slice(-4) === ".htm";
}

function read (name, file) {
  var path = __dirname + "/" + name + "/" + file;

  var contents = "";

  try {
    contents = fs.readFileSync(path, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }

  return contents;
}

function loadPlugins (plugins) {
  var _list = {};
  var _plugins = [];
  var _prerenderers = [];

  Object.keys(plugins).forEach(function (name) {
    var plugin = plugins[name];

    if (plugin.disabled) return;

    // Generate the title and ID automatically
    // for each plugin to avoid bloatage
    // Plugins are used by default unless
    // explicitly blacklisted in config
    plugin.title = plugin.title || deCamelize(name);
    plugin.description = marked.parse(plugin.description || "");
    plugin.id = name;

    // undefined -> true, defined to defined
    plugin.optional =
      plugin.optional === undefined || plugin.optional !== false;
    plugin.isDefault =
      plugin.isDefault === undefined || plugin.isDefault !== false;

    // undefined -> false, defined to defined
    plugin.first = !!plugin.first;

    // This goes on the plugin settings page
    // and is used to pass options to each plugin
    // JS to be appended to every user blog
    // CSS to be appended to every user blog
    // HTML to be appended to every full entry
    plugin.formHTML = read(name, "form.html");
    plugin.publicJS = read(name, "public.js");
    plugin.publicCSS = read(name, "public.css");
    plugin.entryHTML = read(name, "entry.html");

    // Store this plugin for internal use
    // plugins[name] = plugin;
    if (plugin.first) {
      _plugins.unshift(plugin);
    } else {
      _plugins.push(plugin);
    }

    if (plugin.prerender) {
      _prerenderers.push(plugin);
    }

    _list[name] = plugin;

    // Push this plugin to the list of
    // default plugins for each user
    defaultPlugins[name] = {
      enabled: plugin.isDefault,
      options: _.cloneDeep(plugin.options || {})
    };
  });

  return {
    plugins: _plugins,
    prerenderers: _prerenderers,
    list: _list
  };
}

function Timeout (name, cb) {
  return setTimeout(function () {
    console.log(name + " timed out. Moving to next plugin.");
    cb();
  }, TIMEOUT);
}

module.exports = {
  convert: convert,
  load: load,
  list: list,
  defaultList: defaultPlugins
};
