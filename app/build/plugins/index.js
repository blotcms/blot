const { marked } = require("marked");
var config = require("config");
var cheerio = require("cheerio");
var fs = require("fs");
var ensure = require("helper/ensure");
var extend = require("helper/extend");
var deCamelize = require("helper/deCamelize");
var time = require("helper/time");
var _ = require("lodash");
var withResults = require("../withResults");
const BLOT_CDN_TOKEN = require("blog/render/replaceFolderLinks/cdnToken");
const { GLOBAL_STATIC_SUBDIRECTORIES } = require("blog/lib/staticPaths");

// A plugin's public.css is appended to a blog's stylesheet by {{{app_css}}},
// after the template has been wrapped for the CDN, so its links to Blot's own
// static files (the KaTeX fonts) would reach the origin. Point them at the
// CDN, which serves the same paths, through the token the render middleware
// swaps for the real origin.
const GLOBAL_STATIC_URL = new RegExp(
  "url\\((\\s*['\"]?)(" + GLOBAL_STATIC_SUBDIRECTORIES.join("|") + ")/",
  "g"
);

function cdnGlobalStaticUrls(css) {
  return css.replace(GLOBAL_STATIC_URL, "url($1" + BLOT_CDN_TOKEN + "$2/");
}

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
  zoom: require("./zoom"),
  // Must run last: it bakes any remaining folder-relative href/src/poster/
  // srcset into a versioned CDN URL, so it needs to run after every plugin
  // that could itself introduce a new folder-relative link (e.g. autoImage).
  folderAssets: require("./folderAssets"),
});

var list = loaded.list;
var plugins = loaded.plugins;
var prerenderers = loaded.prerenderers;

// Takes a string and based on the user's
// plugins converts it into an HTML string. Calls back with
// (err, html, dependencies); without a callback it resolves to
// [html, dependencies].
async function convert(blog, path, contents) {
  ensure(contents, "string").and(path, "string").and(blog, "object");

  var enabled = Enabled(blog.plugins);
  var dependencies = [];

  // This is passed to all plugins
  // I need to change this when we move
  // to HTTPS... Ideally it shouldn't be
  // needed. I'd look up local files on disk...
  var globalOptions = {
    isHTML: isHTML(path),
    domain: blog.domain,
    handle: blog.handle,
    blogID: blog.id,
    path: path,
    baseURL: "https://" + blog.handle + "." + config.host,
  };

  for (const plugin of prerenderers) {
    const id = plugin.id;

    // Only skip this plugin if it's optional
    // and if the user has disabled it.
    if (plugin.optional && !enabled[id]) {
      continue;
    }

    // The options for this plugin are not
    // neccessarily associated with the blog,
    // especially if it is a required plugin
    const blogOptions = blog.plugins[id] ? blog.plugins[id].options : {};
    const options = {};
    const prerender = plugin.prerender;

    extend(options).and(blogOptions).and(globalOptions);

    await runPlugin(
      id,
      function (callback) {
        prerender(contents, callback, options);
      },
      function (err, result) {
        if (result && !err) contents = result;
      }
    );
  }

  // Don't decode entities, preserve the original content
  var $ = cheerio.load(contents, { decodeEntities: false }, false);

  for (const plugin of plugins) {
    const id = plugin.id;

    if (!plugin.render) continue;

    if (plugin.optional && !enabled[id]) {
      continue;
    }

    const options = {};
    const blogOptions = blog.plugins[id] ? blog.plugins[id].options : {};

    extend(options).and(blogOptions).and(globalOptions);

    await runPlugin(
      id,
      function (callback) {
        // Plugins should call their render callbacks with
        // cb(null, { newDependencies }) to allow us to extend
        // the result object with future fields (e.g. toc).
        plugin.render($, callback, options);
      },
      function (err, result) {
        const res = Array.isArray(result)
          ? { newDependencies: result }
          : result || {};

        if (res.newDependencies) {
          dependencies = dependencies.concat(res.newDependencies);
        }
      }
    );
  }

  // Return the entry's completed HTML
  // pass the HTML so it can be rendered totally tast
  return [$.html(), dependencies];
}

// Calls a plugin, which takes a callback, and resolves once it has called
// back, or once TIMEOUT has passed without it doing so, so that one plugin
// that never calls back cannot hold up the others. The plugin's late
// callback still runs `handle`, as it always did.
function runPlugin(id, call, handle) {
  return new Promise(function (resolve) {
    var timeout = Timeout(id, resolve);

    time(id);

    try {
      call(function (err, result) {
        time.end(id);
        clearTimeout(timeout);

        handle(err, result);

        resolve();
      });
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }
  });
}

// Load plugin templates. This is synchronous work, so it is
// async only to match the callback API it used to have.
async function load(file, blogPlugins) {
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

  return response;
}

function Enabled(blogPlugins) {
  var enabled = {};

  for (var i in blogPlugins) if (blogPlugins[i].enabled) enabled[i] = true;

  return enabled;
}

function isHTML(path) {
  return path.slice(-5) === ".html" || path.slice(-4) === ".htm";
}

function read(name, file) {
  var path = __dirname + "/" + name + "/" + file;

  var contents = "";

  try {
    contents = fs.readFileSync(path, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }

  return contents;
}

function loadPlugins(plugins) {
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
    // A plugin can supply publicJS itself (e.g. from an npm package) instead
    // of a public.js file.
    plugin.publicJS =
      typeof plugin.publicJS === "string"
        ? plugin.publicJS
        : read(name, "public.js");
    plugin.publicCSS = cdnGlobalStaticUrls(read(name, "public.css"));
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
      options: _.cloneDeep(plugin.options || {}),
    };
  });

  return {
    plugins: _plugins,
    prerenderers: _prerenderers,
    list: _list,
  };
}

function Timeout(name, cb) {
  return setTimeout(function () {
    console.warn(name + " timed out. Moving to next plugin.");
    cb();
  }, TIMEOUT);
}

module.exports = {
  convert: withResults(convert),
  load: load,
  list: list,
  defaultList: defaultPlugins,
};
