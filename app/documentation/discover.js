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

const YEAR = 365.25 * 24 * 60 * 60 * 1000;

// "7 years on Blot", from a featured site's tenure (ms), or "" if unknown
function yearsOnBlot(tenure) {
  if (!(tenure > 0)) return "";
  const years = Math.floor(tenure / YEAR);
  if (years < 1) return "New to Blot";
  return years + (years === 1 ? " year" : " years") + " on Blot";
}

// What the popover shown on hovering a name or avatar needs: a featured
// site's details from sites.txt in place of the blog's own, but never in
// place of a profile the maintainer set (site.custom, models/discover/profile)
function popover(site, featured) {
  const custom = site.custom || {};

  return {
    name: custom.name ? site.name : (featured && featured.name) || site.name,
    address: (site.host || "").replace(/^www\./, ""),
    url: site.url,
    featuredImage: featured && !custom.avatar ? featured.image : "",
    avatar: site.avatar || "",
    initial: site.initial || "",
    bio: custom.bio ? site.bio : featured ? featured.bio : "",
    years: featured ? yearsOnBlot(featured.tenure) : "",
  };
}

// Gives each card the name and avatar of a featured site from sites.txt, and
// the popover. Also used by the confirm page's preview (dashboard/discover).
function decorate(posts, featuredSites) {
  const byHost = new Map();
  for (const site of featuredSites || [])
    byHost.set(site.host.replace(/^www\./, ""), site);

  for (const post of posts) {
    const match =
      post.site.host && byHost.get(post.site.host.replace(/^www\./, ""));

    const custom = post.site.custom || {};

    if (match) {
      if (!custom.name) post.site.name = match.name;
      if (!custom.avatar) post.site.featuredImage = match.image;
    }

    post.popover = popover(post.site, match);
  }

  return posts;
}

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

async function page(req, res, next) {
  try {
    const { posts, next: more } = await Discover.list({
      before: req.query.before,
    });

    const featured = res.locals.featured || { sites: [] };
    const hosts = await includedHosts(featured.sites || []);

    res.locals.title = "Discover";
    res.locals.description = "Posts from sites on Blot";
    res.locals.fullWidth = true;
    decorate(posts, featured.sites);

    const sites = (featured.sites || [])
      .filter((site) => hosts.has(site.host))
      .slice(0, SIDEBAR_SITES)
      .map((site) => ({
        ...site,
        popover: popover(
          { host: site.host, url: site.link, name: site.name },
          site
        ),
      }));

    res.locals.discover = {
      posts,
      next: more ? "/discover?before=" + more : "",
      // The first few; "See all" links to /discover/people for the rest
      sites,
    };

    res.render("discover");
  } catch (err) {
    next(err);
  }
}

module.exports = page;
module.exports.decorate = decorate;
