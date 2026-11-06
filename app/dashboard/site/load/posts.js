const Entries = require("models/entries");
const Entry = require("models/entry");
const moment = require("moment");
// Adds moment().tz()
require("moment-timezone");
const { promisify } = require("util");
const { LRUCache } = require("lru-cache");

// The Posts page lists its filter a page at a time
const POSTS_PER_PAGE = 50;
const MAX_PAGE = 1000;
const NUMBER_OF_OVERVIEW_POSTS_TO_DISPLAY = 3;
const getListIDs = promisify(Entries.getListIDs);
const getListTotal = promisify(Entries.getListTotal);
// Entry.get calls back with the entries only, no error argument
const getEntries = (blogID, ids) =>
  new Promise((resolve) => Entry.get(blogID, ids, resolve));
const lists = [
  {
    name: "entries",
    key: "posts",
    filterTitle: "Posts",
    title: "Published posts",
  },
  { name: "pages", key: "pages", filterTitle: "Pages", title: "Pages" },
  { name: "drafts", key: "drafts", filterTitle: "Drafts", title: "Drafts" },
  {
    name: "scheduled",
    key: "scheduled",
    filterTitle: "Scheduled",
    title: "Scheduled posts",
    ascending: true,
  },
];

// Keyed on the blog's cacheID, which a sync or a scheduled post bumps when it
// finishes. It is stored in Redis, so blue and green agree on it.
const cache = new LRUCache({ max: 2000 });

// The overview needs the first few of every list (it shows the first that
// has any); the Posts page needs one page of its filter and the others'
// totals for their pills. getListIDs has no offset, so a later page reads the
// IDs before it too, which is cheap next to loading the entries.
async function loadLists(blogID, { filter, page }) {
  const results = await Promise.all(
    lists.map(async function (list) {
      const wanted = filter ? list.key === filter : true;
      const count = filter
        ? page * POSTS_PER_PAGE
        : NUMBER_OF_OVERVIEW_POSTS_TO_DISPLAY;
      const [ids, total] = await Promise.all([
        wanted
          ? getListIDs(blogID, list.name, {
              first: count,
              ascending: list.ascending,
            })
          : [],
        getListTotal(blogID, list.name),
      ]);

      return {
        list,
        ids: filter ? ids.slice((page - 1) * POSTS_PER_PAGE) : ids,
        total,
      };
    })
  );

  const ids = results.reduce(function (allIDs, result) {
    return allIDs.concat(result.ids);
  }, []);

  const entries = await getEntries(blogID, ids);
  const entriesByID = new Map(
    entries.map(function (entry) {
      return [entry.id, entry];
    })
  );

  return results.map(function (result) {
    return {
      list: result.list,
      total: result.total,
      items: result.ids
        .map(function (id) {
          return entriesByID.get(id);
        })
        .filter(Boolean)
        .map(function (entry) {
          return {
            title: entry.title || entry.path,
            dateStamp: entry.dateStamp,
            urlPath: entry.path
              .replace(/^\/+/, "")
              .split("/")
              .map(encodeURIComponent)
              .join("/"),
          };
        }),
    };
  });
}

function parsePage(value) {
  const page = parseInt(value, 10);
  if (!(page >= 1)) return 1;
  return Math.min(page, MAX_PAGE);
}

module.exports = async function (req, res, next) {
  const blogID = req.blog.id;
  const filter = res.locals.isPostsView ? res.locals.dashboardFilter : null;
  const page = filter ? parsePage(req.query.page) : 1;
  res.locals.postCount = 0;
  res.locals.postGroups = [];

  try {
    const key = `${blogID}:${req.blog.cacheID}:${filter}:${page}`;
    let results = cache.get(key);

    if (!results) {
      results = await loadLists(blogID, { filter, page });
      cache.set(key, results);
    }

    res.locals.postGroups = results.map(function (result) {
      // A scheduled post shows when it goes out; the others how long ago.
      // Every date has the full date as its tooltip.
      const scheduled = result.list.key === "scheduled";
      const items = result.items.map(function (item) {
        const date = moment(item.dateStamp).tz(req.blog.timeZone || "UTC");
        return {
          title: item.title,
          date: scheduled ? date.format("MMM D, YYYY, h:mm A") : date.fromNow(),
          datetime: date.toISOString(),
          fullDate: date.format("MMMM D, YYYY, h:mm A"),
          urlPath: item.urlPath,
        };
      });

      const isActive = res.locals.dashboardFilter === result.list.key;

      return {
        key: result.list.key,
        url: res.locals.base + "/" + result.list.key,
        // Scheduled posts stand out, so one scheduled by mistake is noticed
        countClass:
          result.list.key === "scheduled"
            ? "site-dashboard-view-count is-scheduled"
            : "site-dashboard-view-count",
        filterTitle: result.list.filterTitle,
        linkLabel: result.list.filterTitle.toLowerCase(),
        title: result.list.title,
        count: result.total,
        items: items,
        isActive: isActive,
        filterClass: isActive
          ? "site-dashboard-post-filter is-active"
          : "site-dashboard-post-filter",
        ariaCurrent: isActive ? "page" : "",
        isVisible: res.locals.isAllPostsFilter || isActive,
      };
    });

    // The overview lists one group, the first with anything in it
    // (usually published posts), and its pill shows as selected. The pills
    // lead to the Posts page, so none is marked as the current page.
    if (res.locals.isOverviewView) {
      const first = res.locals.postGroups.find((group) => group.count);
      res.locals.postGroups.forEach((group) => {
        group.isVisible = group === first;
        group.filterClass =
          group === first
            ? "site-dashboard-post-filter is-active"
            : "site-dashboard-post-filter";
      });
    }

    res.locals.postCount = results.reduce(function (sum, result) {
      return sum + result.total;
    }, 0);

    const activeGroup = res.locals.postGroups.find(function (group) {
      return group.isActive;
    });

    // Previous and Next links (Scheduled lists the soonest first, so not
    // Newer and Older as on the Activity page)
    if (activeGroup) {
      const url = (n) => activeGroup.url + (n > 1 ? "?page=" + n : "");
      res.locals.hasNewerPosts = page > 1;
      res.locals.newerPostsURL = url(page - 1);
      res.locals.hasOlderPosts =
        page < MAX_PAGE && activeGroup.count > page * POSTS_PER_PAGE;
      res.locals.olderPostsURL = url(page + 1);
    }

    if (activeGroup && activeGroup.count === 0) {
      res.locals.emptyPostFilterMessage =
        "No " + activeGroup.filterTitle.toLowerCase() + " yet.";
    }
  } catch (err) {
    console.log(err);
  }

  next();
};
