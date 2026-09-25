// This middleware appends the list of featured sites
// to the view used to render a page. It filters the
// list asynchronously to ensure that featured sites
// still point to Blot. This filtering should not block
// the server's boot. This filtering is also rescheduled
// once per day to ensure sites are fresh.
const fs = require("fs-extra");
const config = require("config");
const { CATEGORIES } = require("./categories");

const modify = (i) => {
  return i[0].toUpperCase() + i.slice(1);
};

const loadFeatured = async () => {
  const featuredPath = config.data_directory + "/featured/featured.json";

  // if the JSON file doesn't exist, attempt to create it by copying the seed data
  if (!fs.existsSync(featuredPath)) {
    await fs.copy(__dirname + '/featured.json', featuredPath);
  }

  try {
    const json = await fs.readFile(featuredPath, "utf-8");
    const parsed = JSON.parse(json);

    return {
      ...parsed,
      sites: parsed.sites.map(i => {
        return {
          ...i,
          bio: modify(i.bio),
          host_without_www: i.host.replace(/^www\./, "")
        };
      })
    };
  } catch (e) {
    console.error(e);
  }
}

module.exports = async function (req, res, next) {
  try {
    res.locals.featured = await loadFeatured();
    res.locals.categories = CATEGORIES.map((category) => ({
      slug: category.slug,
      label: category.label,
      href: `/examples/${category.slug}`,
      active: req.params.category === category.slug,
    }));
    res.locals.allCategoriesActive = !req.params.category;
    next();
  } catch (err) {
    next(err);
  }
};
