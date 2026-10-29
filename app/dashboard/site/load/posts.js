const Entries = require("models/entries");
const Entry = require("models/entry");
const moment = require("moment");
const { promisify } = require("util");

const NUMBER_OF_POSTS_TO_DISPLAY = 5;
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

module.exports = async function (req, res, next) {
  const blogID = req.blog.id;
  res.locals.postCount = 0;
  res.locals.postGroups = [];

  try {
    const results = await Promise.all(
      lists.map(async function (list) {
        const [ids, total] = await Promise.all([
          getListIDs(blogID, list.name, {
            first: NUMBER_OF_POSTS_TO_DISPLAY,
            ascending: list.ascending,
          }),
          getListTotal(blogID, list.name),
        ]);

        return { list, ids, total };
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

    res.locals.postGroups = results.map(function (result) {
      const items = result.ids
        .map(function (id) {
          return entriesByID.get(id);
        })
        .filter(Boolean)
        .map(function (entry) {
          return {
            title: entry.title || entry.path,
            date: moment(entry.dateStamp).fromNow(),
            urlPath: entry.path
              .replace(/^\/+/, "")
              .split("/")
              .map(encodeURIComponent)
              .join("/"),
          };
        });

      const isActive = res.locals.dashboardFilter === result.list.key;

      return {
        key: result.list.key,
        filterTitle: result.list.filterTitle,
        title: result.list.title,
        count: result.total,
        items: items,
        moreCount: Math.max(0, result.total - items.length),
        isActive: isActive,
        isVisible: res.locals.isAllPostsFilter || isActive,
      };
    });

    res.locals.postCount = results.reduce(function (sum, result) {
      return sum + result.total;
    }, 0);

    const activeGroup = res.locals.postGroups.find(function (group) {
      return group.isActive;
    });

    if (activeGroup && activeGroup.count === 0) {
      res.locals.emptyPostFilterMessage =
        "No " + activeGroup.filterTitle.toLowerCase() + " yet.";
    }
  } catch (err) {
    console.log(err);
  }

  next();
};
