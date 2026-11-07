const blogScheme = require("models/blog/scheme");
const pluginList = require("build/plugins").list;
const { pluginsOnFlagsPage } = require("./load/plugins");
const blogDefaults = require("models/blog/defaults");

const flagKeys = Object.keys(blogScheme.TYPE.flags || {});
const defaultFlags = blogDefaults.flags || {};

const labelize = (key) =>
  key
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

exports.get = (req, res) => {
  const currentFlags = {
    ...defaultFlags,
    ...(req.blog.flags || {}),
  };

  const flags = flagKeys.map((key) => ({
    key,
    label: labelize(key),
    value: !!currentFlags[key],
    defaultValue: !!defaultFlags[key],
  }));

  // Settings most sites leave on, kept here rather than on the Settings tabs
  const plugins = pluginsOnFlagsPage
    .filter((id) => pluginList[id])
    .map((id) => {
      const state = (req.blog.plugins || {})[id];
      return {
        id,
        description: pluginList[id].description,
        checked: state && state.enabled ? "checked" : "",
      };
    });

  res.locals.breadcrumbs.add("Flags", "flags");

  res.render("dashboard/site/settings/flags", {
    title: "Flags",
    flags,
    plugins,
  });
};
