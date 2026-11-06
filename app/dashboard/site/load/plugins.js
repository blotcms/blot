const Mustache = require("mustache");
const pluginList = require("build/plugins").list;
const defaultList = require("build/plugins").defaultList;
const arrayify = require("helper/arrayify");
const capitalize = require("helper/capitalize");
const deCamelize = require("helper/deCamelize");

const pluginsToHide = [];

module.exports = function (req, res, next) {
  const blog = req.blog;

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

    if (plugins[i].formHTML)
      plugins[i].formHTML = Mustache.render(formHTML, options);

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

    if (!pluginsToHide.includes(plugin.name)) {
      categories[name].plugins.push(plugin);
    }
  });

  res.locals.categories = categories;

  return next();
};
