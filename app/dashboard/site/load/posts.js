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

// The columns each filter's rows show after the title, as [label, width]
// and how a row fills them
const COLUMNS = {
  posts: [
    ["File", "22%", (item) => ({ text: item.name, title: item.path })],
    [
      "Published",
      "16%",
      (item) => ({ text: item.published, datetime: item.publishedISO }),
    ],
    ["Tags", "18%", (item) => ({ text: item.tags })],
  ],
  pages: [
    ["URL", "26%", (item) => ({ text: item.url })],
    ["Menu", "12%", (item) => ({ text: item.inMenu })],
    [
      "Updated",
      "16%",
      (item) => ({ text: item.updated, datetime: item.updatedISO }),
    ],
  ],
  drafts: [
    ["File", "30%", (item) => ({ text: item.name, title: item.path })],
    [
      "Last edited",
      "20%",
      (item) => ({ text: item.updated, datetime: item.updatedISO }),
    ],
  ],
  scheduled: [
    [
      "Publishes",
      "30%",
      // When, in the site's time zone, and how soon
      (item) => ({
        text: item.publishes + " · " + moment(item.dateStamp).fromNow(),
        datetime: item.publishedISO,
      }),
    ],
    ["File", "22%", (item) => ({ text: item.name, title: item.path })],
  ],
};

// Keyed on the blog's cacheID, which a sync or a scheduled post bumps when it
// finishes. It is stored in Redis, so blue and green agree on it.
const cache = new LRUCache({ max: 2000 });

// Every page with the folder's filters needs each list's total; a filter
// page also needs one page of its list, shown as rows whose columns suit the
// filter (see COLUMNS). getListIDs has no offset, so a later page reads the
// IDs before it too, which is cheap next to loading the entries.
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
        // Plain dates, not "Today": the list is cached until the next sync
        items: found.map(function (entry) {
          const date = (stamp) =>
            stamp ? moment(stamp).tz(timeZone || "UTC") : null;
          const published = date(entry.dateStamp);
          const updated = date(entry.updated);
          return {
            title: entry.title || entry.path.split("/").pop(),
            name: entry.path.split("/").pop(),
            path: entry.path,
            urlPath: entry.path
              .replace(/^\/+/, "")
              .split("/")
              .map(encodeURIComponent)
              .join("/"),
            url: entry.url || "",
            tags: (entry.tags || []).join(", "),
            inMenu: entry.menu ? "In menu" : "",
            dateStamp: entry.dateStamp,
            published: published ? published.format("MMM D, YYYY") : "",
            publishes: published ? published.format("MMM D, YYYY, h:mm A") : "",
            publishedISO: published ? published.toISOString() : "",
            updated: updated ? updated.format("MMM D, YYYY") : "",
            updatedISO: updated ? updated.toISOString() : "",
          };
        }),
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
    // The filter page's table: a title column, the filter's own columns, and
    // a narrow one for each row's menu
    const columns = activeGroup ? COLUMNS[activeGroup.key] || [] : [];
    res.locals.postColumns = columns.map(([label, width]) => ({
      label,
      width,
    }));
    res.locals.postItems = activeGroup
      ? activeGroup.items.map((item) => ({
          ...item,
          cells: columns.map(([, , cell]) => cell(item)),
        }))
      : [];

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
