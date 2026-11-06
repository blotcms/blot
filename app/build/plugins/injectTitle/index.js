// Obsidian users often write notes without an explicit first-level heading
// because the app treats the file name as the document title. When those files
// are published, the missing heading can produce awkward layouts, so this
// plugin adds a derived `<h1>` when needed, but only for Markdown files to
// avoid affecting other asset types. The sync layer enables it automatically
// for detected Obsidian vaults, but authors can still opt out via the plugin
// settings.
const titlify = require("../../prepare/titlify");
const makeSlug = require("helper/makeSlug");
const withPluginCallback = require("../withPluginCallback");

async function render($, options = {}) {
  try {
    if (!isMarkdown(options.path)) return;
    if (!needsTitle($)) return;

    const title = getTitleFromPath(options.path);

    if (!title) return;

    const heading = $("<h1></h1>").text(title);

    // add an ID for the heading
    heading.attr("id", makeSlug(title));

    // add a special class to the heading
    heading.addClass("injected-title");

    const firstChild = $.root().children().first();

    if (firstChild && firstChild.length) {
      firstChild.before(heading);
    } else {
      $.root().append(heading);
    }
  } catch (err) {
    // Ignore errors to avoid breaking the build pipeline
  }
}

function needsTitle($) {
  return $("h1").length === 0;
}

function getTitleFromPath(path) {
  if (!path) return "";

  try {
    return titlify(path) || "";
  } catch (err) {
    return "";
  }
}

function isMarkdown(path = "") {
  try {
    return path.toLowerCase().endsWith(".md");
  } catch (err) {
    return false;
  }
}

module.exports = {
  render: withPluginCallback(render),
  isDefault: false,
  category: "headings",
  title: "Inject title",
  description: "Insert a heading from file name if missing",
  options: {
    manuallyDisabled: false,
  },
};
