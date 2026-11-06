const Entries = require("models/entries");
const Entry = require("models/entry");
const Stat = require("../folder/stat");
const { promisify } = require("util");
const { LRUCache } = require("lru-cache");

// The Posts page lists its filter a page at a time
const POSTS_PER_PAGE = 50;
const MAX_PAGE = 1000;
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

// Every page with the folder's filter pills needs each list's total; a
// filter page also needs one page of its list, shown as folder rows (file
// name, size and date modified, from each file's folder stat). getListIDs has
// no offset, so a later page reads the IDs before it too, which is cheap next
// to loading the entries.
async function loadLists(blogID, { filter, page, timeZone }) {
  const results = await Promise.all(
    lists.map(async function (list) {
      const wanted = !!filter && list.key === filter;
      const [ids, total] = await Promise.all([
        wanted
          ? getListIDs(blogID, list.name, {
              first: page * POSTS_PER_PAGE,
              ascending: list.ascending,
            })
          : [],
        getListTotal(blogID, list.name),
      ]);

      return {
        list,
        ids: ids.slice((page - 1) * POSTS_PER_PAGE),
        total,
      };
    })
  );

  const ids = results.reduce(function (allIDs, result) {
    return allIDs.concat(result.ids);
  }, []);

  const entries = ids.length ? await getEntries(blogID, ids) : [];
  const entriesByID = new Map(
    entries.map(function (entry) {
      return [entry.id, entry];
    })
  );

  return Promise.all(
    results.map(async function (result) {
      const found = result.ids.map((id) => entriesByID.get(id)).filter(Boolean);

      return {
        list: result.list,
        total: result.total,
        items: await Promise.all(
          found.map(async function (entry) {
            // A file removed since it was indexed shows without a size or date
            const stat = await Stat(blogID, entry.path, timeZone).catch(
              () => null
            );
            return {
              name: entry.path.split("/").pop(),
              path: entry.path,
              urlPath: entry.path
                .replace(/^\/+/, "")
                .split("/")
                .map(encodeURIComponent)
                .join("/"),
              size: stat ? stat.size : "--",
              modified: stat ? stat.modified : "",
            };
          })
        ),
      };
    })
  );
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
    const timeZone = req.blog.timeZone || "UTC";
    const key = `${blogID}:${req.blog.cacheID}:${timeZone}:${filter}:${page}`;
    let results = cache.get(key);

    if (!results) {
      results = await loadLists(blogID, { filter, page, timeZone });
      cache.set(key, results);
    }

    res.locals.postGroups = results.map(function (result) {
      const isActive = res.locals.dashboardFilter === result.list.key;

      return {
        key: result.list.key,
        url: res.locals.base + "/" + result.list.key,
        // A selected pill turns its filter off: it leads back to the folder
        href: isActive
          ? res.locals.base
          : res.locals.base + "/" + result.list.key,
        // Scheduled posts stand out, so one scheduled by mistake is noticed
        showDot: result.list.key === "scheduled" && result.total > 0,
        filterTitle: result.list.filterTitle,
        linkLabel: result.list.filterTitle.toLowerCase(),
        title: result.list.title,
        count: result.total,
        items: result.items,
        isActive: isActive,
        filterClass: isActive
          ? "folder-filters__item is-selected"
          : "folder-filters__item",
        ariaCurrent: isActive ? "page" : "",
      };
    });

    res.locals.postCount = results.reduce(function (sum, result) {
      return sum + result.total;
    }, 0);

    const activeGroup = res.locals.postGroups.find(function (group) {
      return group.isActive;
    });
    res.locals.postItems = activeGroup ? activeGroup.items : [];

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
