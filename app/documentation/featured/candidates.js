// Should only run in production, will pull in suggestions
// for new sites to feature on the homepage and list the email
// to contact for the site.

var Blog = require("models/blog");
var moment = require("moment");
var Entries = require("models/entries");
var User = require("models/user");
var colors = require("colors/safe");
var verifySiteIsOnline = require("./verifySiteIsOnline");

if (require.main === module) {
  main().then(function (sites) {
    console.log("Found " + sites.length + " sites to consider:\n");

    sites.forEach(function (site) {
      console.log();
      console.log(
        "https://" + site.host,
        colors.dim("last published", moment(site.lastPublishedPost).fromNow())
      );
      // console.log(
      //   colors.dim(
      //     `mailto:${
      //       site.email
      //     }?subject=Link%20to%20you%20on%20Blot's%20homepage%3F&body=${encodeURIComponent(`Hello, I'm updating Blot's homepage and I'm going to add some new featured sites hosted on Blot. Would you mind if I added a link to yours? I completely understand if you'd rather not, so no pressure.

      //     Sincerely, David`)}`
      //   )
      // );
    });

    process.exit();
  });
}

// We want to be able to check if a candidate is already
// featured, so transform the existing list into an array
var featured = require("./featured").sites.map(function (site) {
  return site.host;
});

async function main() {
  var ids = await Blog.getAllIDs();

  var sites = await Promise.all(
    ids.map(async function (id) {
      var blog, user, page;

      try {
        blog = await Blog.get({ id: id });
      } catch (err) {
        return;
      }

      if (!blog || blog.isDisabled || !blog.domain) return;

      try {
        user = await User.getById(blog.owner);
      } catch (err) {
        return;
      }

      if (!user || user.isDisabled) return;

      try {
        page = await Entries.getPage(blog.id, { pageNumber: 1, pageSize: 1 });
      } catch (error) {
        return;
      }

      var entries = page.entries;
      if (!entries || !entries.length) return;

      return {
        host: blog.domain,
        email: user.email,
        lastPublishedPost: entries[0].dateStamp,
      };
    })
  );

  sites = sites.filter(function (site) {
    return site && site.host && featured.indexOf(site.host) === -1;
  });

  // ensure we're only checking unique sites
  sites = sites.filter(function (site, index, self) {
    return (
      index ===
      self.findIndex(function (t) {
        return t.host === site.host;
      })
    );
  });

  const filteredSites = [];

  console.log("Checking", sites.length, "candidates");

  for (var i = 0; i < sites.length; i++) {
    var isOnline = await verifySiteIsOnline(sites[i].host);
    if (isOnline) {
      filteredSites.push(sites[i]);
    }
  }

  console.log(filteredSites.length, "candidates remain post-filter");

  filteredSites.sort(function (a, b) {
    if (a.lastPublishedPost > b.lastPublishedPost) return 1;
    if (b.lastPublishedPost > a.lastPublishedPost) return -1;
    if (a.lastPublishedPost === b.lastPublishedPost) return 0;
  });

  return filteredSites;
}
