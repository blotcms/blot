const fs = require("fs-extra");
const root = require("helper/rootDir");

const TEMPLATES_DIRECTORY = root + "/app/templates/source";

// Templates without an explicit demo_folder are previewed on this folder.
const DEFAULT_DEMO_FOLDER = "david";

function list() {
  return fs
    .readdirSync(TEMPLATES_DIRECTORY)
    .filter((i) => !i.startsWith(".") && !i.endsWith(".md"))
    .sort();
}

function forTemplate(template) {
  const json = fs.readJSONSync(
    TEMPLATES_DIRECTORY + "/" + template + "/package.json"
  );
  return (json.locals && json.locals.demo_folder) || DEFAULT_DEMO_FOLDER;
}

// Turns a comma-separated list of template names into the list of templates to
// work on, throwing on a typo rather than silently screenshotting nothing.
function parse(input) {
  const all = list();

  if (!input) return all;

  const requested = input
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  if (!requested.length) return all;

  const unknown = requested.filter((name) => !all.includes(name));

  if (unknown.length) {
    throw new Error(
      "Unknown template" +
        (unknown.length === 1 ? " " : "s ") +
        unknown.join(", ") +
        ". Available templates: " +
        all.join(", ")
    );
  }

  return [...new Set(requested)];
}

// The demo folders needed to preview a set of templates. Only these folders
// have to be built before screenshots can be taken.
function forTemplates(templates) {
  return [...new Set(templates.map(forTemplate))].sort();
}

module.exports = { list, parse, forTemplate, forTemplates, DEFAULT_DEMO_FOLDER };
