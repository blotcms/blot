const Entries = require("models/entries");
const Entry = require("models/entry");
const moment = require("moment");
// Adds moment().tz()
require("moment-timezone");
const { LRUCache } = require("lru-cache");

// The Posts page lists its filter a page at a time
const POSTS_PER_PAGE = 50;
const MAX_PAGE = 1000;
const getListIDs = Entries.getListIDs;
const getListTotal = Entries.getListTotal;
// A failed read is the same as no entries
const getEntries = (blogID, ids) => Entry.get(blogID, ids).catch(() => []);
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
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

// How each column sorts: by a text or a number from the entry, and which
// way its first click goes. "date" is the list's own order (by dateStamp),
// so it is read a page at a time like the default order; the others read
// the whole list once and keep its order in the cache.
const SORTS = {
  title: { first: "asc", text: (entry) => entryTitle(entry) },
  file: { first: "asc", text: (entry) => entry.path.split("/").pop() },
  tags: { first: "asc", text: (entry) => (entry.tags || []).join(", ") },
  url: { first: "asc", text: (entry) => entry.url || "" },
  menu: { first: "desc", number: (entry) => (entry.menu ? 1 : 0) },
  updated: { first: "desc", number: (entry) => entry.updated || 0 },
  date: { first: "desc" },
};

// The columns each filter's rows show after the title, as [sort key, label,
// width] and how a row fills them
const COLUMNS = {
  posts: [
    ["file", "File", "22%", (item) => ({ text: item.name, title: item.path })],
    [
      "date",
      "Published",
      "16%",
      (item) => ({ text: item.published, datetime: item.publishedISO }),
    ],
    ["tags", "Tags", "18%", (item) => ({ text: item.tags })],
  ],
  pages: [
    ["url", "URL", "26%", (item) => ({ text: item.url })],
    ["menu", "Menu", "12%", (item) => ({ text: item.inMenu })],
    [
      "updated",
      "Updated",
      "16%",
      (item) => ({ text: item.updated, datetime: item.updatedISO }),
    ],
  ],
  drafts: [
    ["file", "File", "30%", (item) => ({ text: item.name, title: item.path })],
    [
      "updated",
      "Last edited",
      "20%",
      (item) => ({ text: item.updated, datetime: item.updatedISO }),
    ],
  ],
  scheduled: [
    [
      "date",
      "Publishes",
      "30%",
      // When, in the site's time zone, and how soon
      (item) => ({
        text: item.publishes + " · " + moment(item.dateStamp).fromNow(),
        datetime: item.publishedISO,
      }),
    ],
    ["file", "File", "22%", (item) => ({ text: item.name, title: item.path })],
  ],
};

function entryTitle(entry) {
  return entry.title || entry.path.split("/").pop();
}

// The sort a filter page was asked for, if its table has that column
function parseSort(filter, query) {
  const keys = ["title"].concat((COLUMNS[filter] || []).map(([key]) => key));
  if (!keys.includes(query.sort)) return null;
  return { key: query.sort, order: query.order === "desc" ? "desc" : "asc" };
}

// Every ID in the list, in the order a non-date column sorts it. The list
// is read in full once per sort until the next sync bumps the cacheID.
async function sortedIDs(blogID, list, sort) {
  const by = SORTS[sort.key];
  const ids = await getListIDs(blogID, list.name, {});
  const entries = await getEntries(blogID, ids);
  const direction = sort.order === "desc" ? -1 : 1;
  const rows = entries.map((entry) => ({
    id: entry.id,
    value: by.number ? by.number(entry) : by.text(entry),
    title: entryTitle(entry),
  }));

  rows.sort(function (a, b) {
    const result = by.number
      ? a.value - b.value
      : collator.compare(a.value, b.value);
    // Ties stay in title order whichever way the column goes
    return result * direction || collator.compare(a.title, b.title);
  });

  return rows.map((row) => row.id);
}

// One page of the list's IDs: in the list's own order (newest first, or the
// soonest first for Scheduled) unless a column was chosen
async function pageIDs(blogID, list, { page, sort }) {
  const first = page * POSTS_PER_PAGE;
  let ids;

  if (!sort || sort.key === "date") {
    const ascending = sort ? sort.order === "asc" : list.ascending;
    ids = await getListIDs(blogID, list.name, { first, ascending });
  } else {
    ids = await sortedIDs(blogID, list, sort);
  }

  return ids.slice((page - 1) * POSTS_PER_PAGE, first);
}

// Keyed on the blog's cacheID, which a sync or a scheduled post bumps when it
// finishes. It is stored in Redis, so blue and green agree on it.
const cache = new LRUCache({ max: 2000 });

// Every page with the folder's filters needs each list's total; a filter
// page also needs one page of its list, shown as rows whose columns suit the
// filter (see COLUMNS). getListIDs has no offset, so a later page reads the
// IDs before it too, which is cheap next to loading the entries.
async function loadLists(blogID, { filter, page, sort, timeZone }) {
  const results = await Promise.all(
    lists.map(async function (list) {
      const wanted = !!filter && list.key === filter;
      const [ids, total] = await Promise.all([
        wanted ? pageIDs(blogID, list, { page, sort }) : [],
        getListTotal(blogID, list.name),
      ]);

      return { list, ids, total };
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
            title: entryTitle(entry),
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
  const sort = filter ? parseSort(filter, req.query) : null;
  res.locals.postCount = 0;
  res.locals.postGroups = [];

  try {
    const timeZone = req.blog.timeZone || "UTC";
    const sortKey = sort ? sort.key + "." + sort.order : "";
    const key = `${blogID}:${req.blog.cacheID}:${timeZone}:${filter}:${page}:${sortKey}`;
    let results = cache.get(key);

    if (!results) {
      results = await loadLists(blogID, { filter, page, sort, timeZone });
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
    const query = (params) => {
      const search = new URLSearchParams(params).toString();
      return activeGroup.url + (search ? "?" + search : "");
    };
    // Each header links to the next sort in its cycle: its first direction,
    // the other one, then the list's own order (no arrow)
    const header = (key, label, width) => {
      const first = SORTS[key].first;
      const active = sort && sort.key === key;
      let next = { sort: key, order: first };
      if (active && sort.order === first)
        next.order = first === "asc" ? "desc" : "asc";
      else if (active) next = {};
      return {
        key,
        label,
        width,
        href: query(next),
        ariaSort: active
          ? sort.order === "desc"
            ? "descending"
            : "ascending"
          : "none",
      };
    };
    res.locals.postColumns = activeGroup
      ? [header("title", "Title", "auto")].concat(
          columns.map(([key, label, width]) => header(key, label, width))
        )
      : [];
    res.locals.postItems = activeGroup
      ? activeGroup.items.map((item) => ({
          ...item,
          cells: columns.map(([, , , cell]) => cell(item)),
        }))
      : [];
    res.locals.postColumnCount = res.locals.postColumns.length + 1;
    res.locals.postFilterKey = activeGroup ? activeGroup.key : "";

    // Previous and Next links (Scheduled lists the soonest first, so not
    // Newer and Older as on the Activity page), keeping the sort
    if (activeGroup) {
      const sortParams = sort ? { sort: sort.key, order: sort.order } : {};
      const url = (n) => query(n > 1 ? { ...sortParams, page: n } : sortParams);
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
