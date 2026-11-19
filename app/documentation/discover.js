const Discover = require("models/discover");
const blogForHost = require("./featured/blogForHost");

// blot.im/discover (#2639): the posts the maintainer has added, newest
// first, and a sidebar of the featured sites (featured/sites.txt). Runs
// after ./featured, which puts the featured sites in res.locals.featured.
//
// ?before=<cursor> renders the next page. The page's script fetches it and
// moves its cards into the grid, so there is one card template, not two.

// The sidebar leaves out featured sites which have turned Discover off. The
// list barely changes, so which sites are included is cached for a while.
const SIDEBAR_TTL = 10 * 60 * 1000;
const SIDEBAR_SITES = 10;
let sidebar = { at: 0, hosts: null };

// Resolves to the set of featured hosts whose site has includeInDiscover on
async function includedHosts(sites) {
  if (sidebar.hosts && Date.now() - sidebar.at < SIDEBAR_TTL)
    return sidebar.hosts;

  const hosts = new Set();

  for (const site of sites) {
    try {
      const blog = await blogForHost(site.host);
      if (blog && !blog.isDisabled && blog.includeInDiscover === true)
        hosts.add(site.host);
    } catch (err) {
      // leave the site out
    }
  }

  sidebar = { at: Date.now(), hosts };
  return hosts;
}

module.exports = async function (req, res, next) {
  try {
    const { posts, next: more } = await Discover.list({
      before: req.query.before,
    });

    const featured = res.locals.featured || { sites: [] };
    const hosts = await includedHosts(featured.sites || []);

    res.locals.title = "Discover";
    res.locals.description = "Posts from sites on Blot";
    res.locals.fullWidth = true;
    // A featured site's card shows the name and avatar from sites.txt
    const byHost = new Map();
    for (const site of featured.sites || [])
      byHost.set(site.host.replace(/^www\./, ""), site);

    for (const post of posts) {
      const match =
        post.site.host && byHost.get(post.site.host.replace(/^www\./, ""));

      if (match) {
        post.site.name = match.name;
        post.site.featuredImage = match.image;
      }
    }

    res.locals.discover = {
      posts,
      next: more ? "/discover?before=" + more : "",
      // The first few; "See all" links to /examples for the rest
      sites: (featured.sites || [])
        .filter((site) => hosts.has(site.host))
        .slice(0, SIDEBAR_SITES),
      image_size: featured.image_size,
    };

    res.render("discover");
  } catch (err) {
    next(err);
  }
};
