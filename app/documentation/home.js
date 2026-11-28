const { loadTemplates } = require("./build/templates");
const { url: cdnURL } = require("./tools/cdn-url-helper");
const { popover } = require("./discover");

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

// The editors and apps the homepage's tools section shows, each with a
// guide under /how/tools and an icon in views/how/tools/icons
const tools = [
  ["word", "Word", "word.png"],
  ["google-docs", "Google Docs", "google-docs.png"],
  ["obsidian", "Obsidian", "obsidian.png"],
  ["ia-writer", "iA Writer", "ia-writer.png"],
  ["ulysses", "Ulysses", "ulysses.png"],
  ["bear", "Bear", "bear.png"],
  ["typora", "Typora", "typora.png"],
  ["sublime-text", "Sublime Text", "sublime-text.ico"],
  ["emacs", "Emacs", "emacs.png"],
  ["vim", "Vim", "vim.ico"],
  ["lightroom", "Lightroom", "lightroom.png"],
  ["darktable", "darktable", "darktable.ico"],
].map(([slug, name, icon]) => ({ slug, name, icon }));

// How many templates the homepage shows: two rows of three
const TEMPLATES = 6;

// How many finished items the homepage shows
const DONE = 5;

// How many people (featured sites, from ./featured) the homepage shows:
// two rows of avatars on a wide screen
const PEOPLE = 28;

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
    }))
    .slice(0, TEMPLATES);
  const featured = res.locals.featured || {};
  res.locals.homePeople = (featured.sites || [])
    .slice(0, PEOPLE)
    .map((site) => ({
      ...site,
      image_url: cdnURL(site.image),
      image_size: featured.image_size,
      // The hover card the Discover page shows (partials/discover-popover)
      popover: popover(
        { name: site.name, host: site.host, url: site.link },
        site
      ),
    }));
  res.locals.homeTools = tools;
  res.locals.homeDone = (res.locals.recent_commits || []).slice(0, DONE);
  res.locals.homeHasDone = res.locals.homeDone.length > 0;
  res.render("index");
};
