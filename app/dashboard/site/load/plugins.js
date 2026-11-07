const Mustache = require("mustache");
const pluginList = require("build/plugins").list;
const defaultList = require("build/plugins").defaultList;
const arrayify = require("helper/arrayify");
const capitalize = require("helper/capitalize");
const deCamelize = require("helper/deCamelize");

const { LRUCache } = require("lru-cache");

// Settings almost every site leaves on, which are listed on the hidden Flags
// page (site/flags.js) instead of the Settings tabs. Hiding them changes
// nothing about whether they're on: new sites still get every one of them.
const pluginsOnFlagsPage = [
  "codeHighlighting",
  "katex",
  "callouts",
  "wikilinks",
  "autoImage",
  "bluesky",
  "flickr",
  "twitter",
  "videoEmbeds",
  "linkScreenshot",
  "image",
];

// The categories depend only on the blog's plugin settings. Templates only
// read them, so one copy can be shared between requests.
const cache = new LRUCache({ max: 500 });

module.exports = function (req, res, next) {
  const key = JSON.stringify(req.blog.plugins || {});

  if (!cache.has(key)) cache.set(key, loadCategories(req.blog));

  res.locals.categories = cache.get(key);

  return next();
};

function loadCategories(blog) {
  let plugins = JSON.parse(JSON.stringify(pluginList));

  for (let i in plugins) {
    if (!plugins[i].optional) {
      delete plugins[i];
      continue;
    }

    const pluginState = blog.plugins[i] || {
      enabled: false,
      options: defaultList[i]?.options || {},
    };

    let formHTML = plugins[i].formHTML;
    let options = pluginState.options;

    if (plugins[i].formHTML) {
      plugins[i].formHTML = Mustache.render(formHTML, options);
      // Checkbox options save as they change (js/site-settings-autosubmit.js);
      // only typed options (a text field, a menu) need a Save button
      plugins[i].needsSaveButton =
        /<(select|textarea)\b|type=["']?(text|url|email|number)\b/i.test(
          plugins[i].formHTML
        );
    }

    if (pluginState.enabled) plugins[i].checked = "checked";
  }

  let categories = {};

  const change = {
    External: "Services",
  };

  arrayify(plugins, function (plugin) {
    let name = capitalize(deCamelize(plugin.category || "general"));
    let slug = name.split(" ").join("-").toLowerCase();

    if (change[name]) name = change[name];

    categories[name] = categories[name] || {
      name: name,
      plugins: [],
      slug: slug,
      url: "/plugins/" + slug,
    };

    if (categories[name].plugins.length % 3 === 0) {
      plugin.clear = true;
    }

    if (!pluginsOnFlagsPage.includes(plugin.id)) {
      categories[name].plugins.push(plugin);
    }
  });

  // A section whose settings all moved to the Flags page shows nothing
  for (const name in categories) {
    if (!categories[name].plugins.length) delete categories[name];
  }

  return categories;
}

module.exports.pluginsOnFlagsPage = pluginsOnFlagsPage;
