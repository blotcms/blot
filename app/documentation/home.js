const { loadTemplates } = require("./build/templates");

const audiences = new Map([
  ["album", "artists and photographers"],
  ["blog", "writers"],
  ["cv", "artists, researchers, developers and designers"],
  ["documentation", "researchers and developers"],
  ["event", "photographers and designers"],
  ["fieldnotes", "writers, researchers and developers"],
  ["gallery", "artists and photographers"],
  ["hypertext", "researchers and developers"],
  ["index", "writers, researchers and developers"],
  ["journal", "writers"],
  ["links", "writers, researchers and developers"],
  ["magazine", "writers"],
  ["notebook", "writers, researchers and developers"],
  ["organization", "designers"],
  ["portfolio", "artists, photographers and designers"],
  ["profile", "designers"],
  ["studio", "artists and designers"],
  ["text", "writers"],
  ["wireframe", "designers"],
  ["zine", "writers and artists"],
  ["keynote", "researchers, developers and designers"],
]);

const position = new Map(
  [...audiences.keys()].map((slug, index) => [slug, index])
);

module.exports = async function home(req, res) {
  const templates = await loadTemplates();
  const order = (slug) => position.get(slug) ?? position.size;

  res.locals.title = "Blot";
  res.locals.description = "Turns a folder into a website";
  res.locals.hide_title_suffix = true;
  res.locals.mainClass = "home-content";
  res.locals.homeTemplates = templates
    .sort(
      (a, b) => order(a.slug) - order(b.slug) || a.name.localeCompare(b.name)
    )
    .map((template) => ({
      ...template,
      audience: audiences.get(template.slug),
    }));
  res.render("index");
};
