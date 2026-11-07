const Blog = require("models/blog");
const moment = require("moment");
const Path = require("path");
const { LRUCache } = require("lru-cache");

const getStatuses = Blog.getStatuses;
// Status messages look like "Syncing /path". The verbs are published by the
// sync clients (search for progress.publish / folder.status in app/clients)
// and the folder sync; if one is reworded, add it here or its files drop out of
// the activity list.
const verbs = {
  Downloading: "downloaded",
  Syncing: "synced",
  Transferring: "transferred",
  Removing: "removed",
};
const PROGRESS_PREFIX = /^\(\d+\/\d+\)\s+/;
// The status log holds up to 2000 entries (models/blog/setStatus.js). Read it a
// page at a time and stop once there is enough to render.
const STATUS_PAGE_SIZE = 200;
const STATUS_MAX_PAGES = 10;
// Sync groups per Recents page
const GROUPS_PER_PAGE = 10;
const MAX_PAGE = 100;
const MAX_VISIBLE_FILES_PER_GROUP = 8;
// Beyond this a group just says how many more files it has
const MAX_FILES_PER_GROUP = 30;

// Splits "(2/5) Syncing /a/b.txt" into { verb: "synced", path: "/a/b.txt" },
// or returns null for messages that are not file operations.
function parseFileStatus(rawMessage) {
  const message = String(rawMessage || "").replace(PROGRESS_PREFIX, "");
  const verb = Object.keys(verbs).find(function (candidate) {
    return message.startsWith(candidate + " /");
  });

  if (!verb) return null;

  const path = message.slice(verb.length + 1).trim();
  if (!path) return null;

  return { verb: verbs[verb], path };
}

// Each request only adds relative times. The groups change when a new status
// is written, which also updates the blog's latest status in Redis, so that
// status is the cache key and blue and green agree on it.
const cache = new LRUCache({ max: 1000 });

async function loadGroups(blogID, pageNumber) {
  const groups = new Map();
  let index = 0;

  // Stop at the first group past the page, so the last group kept is
  // complete and we know whether an older page exists
  const enough = function () {
    return groups.size > pageNumber * GROUPS_PER_PAGE;
  };

  for (let page = 1; page <= STATUS_MAX_PAGES && !enough(); page++) {
    const { statuses, next: nextPage } = await getStatuses(blogID, {
      page,
      pageSize: STATUS_PAGE_SIZE,
    });

    for (const status of statuses) {
      addStatus(status, index++);
      if (enough()) break;
    }

    if (!nextPage) break;
  }

  function addStatus(status, index) {
    // The status log also contains rebuild and health-check messages. Keep
    // only file operations so this reads like a file history.
    const operation = parseFileStatus(status.message);
    if (!operation) return;

    const path = operation.path;

    const date = status.datestamp || Date.now();
    const key = status.syncID || "status-" + date + "-" + index;
    let group = groups.get(key);

    if (!group) {
      group = {
        date,
        datetime: moment(date).toISOString(),
        files: [],
        totalFiles: 0,
      };
      groups.set(key, group);
    }

    const normalizedPath = Path.posix.normalize(path);
    group.totalFiles++;
    group.files.push({
      verb: operation.verb,
      path: normalizedPath,
      name: Path.posix.basename(normalizedPath),
      urlPath: path
        .replace(/^\/+/, "")
        .split("/")
        .map(encodeURIComponent)
        .join("/"),
    });
  }

  const allGroups = Array.from(groups.values());
  const hasOlder = allGroups.length > pageNumber * GROUPS_PER_PAGE;
  const recentActivity = allGroups.slice(
    (pageNumber - 1) * GROUPS_PER_PAGE,
    pageNumber * GROUPS_PER_PAGE
  );

  recentActivity.forEach(function (group) {
    group.collapsedFiles = group.files.slice(
      MAX_VISIBLE_FILES_PER_GROUP,
      MAX_FILES_PER_GROUP
    );
    group.files = group.files.slice(0, MAX_VISIBLE_FILES_PER_GROUP);
    group.moreFiles = group.totalFiles - group.files.length;
    group.unlistedFiles = Math.max(0, group.totalFiles - MAX_FILES_PER_GROUP);
  });

  return { recentActivity, hasOlder };
}

function withTimes(groups) {
  return groups.map(function (group) {
    return {
      ...group,
      time: moment(group.date).fromNow(),
      fullDate: moment(group.date).format("LLLL"),
    };
  });
}

function parsePage(value) {
  const page = parseInt(value, 10);
  if (!(page >= 1)) return 1;
  return Math.min(page, MAX_PAGE);
}

module.exports = async function (req, res, next) {
  res.locals.recentActivity = [];

  if (!req.blog.client) return next();

  const status = req.blog.status || {};
  const pageNumber = parsePage(req.query.page);
  const key = [req.blog.id, status.datestamp, status.message, pageNumber].join(
    ":"
  );

  try {
    if (!cache.has(key))
      cache.set(key, await loadGroups(req.blog.id, pageNumber));

    const { recentActivity, hasOlder } = cache.get(key);
    const url = (page) =>
      res.locals.base + "/activity" + (page > 1 ? "?page=" + page : "");
    res.locals.hasOlderActivity = hasOlder;
    res.locals.olderActivityURL = url(pageNumber + 1);
    res.locals.hasNewerActivity = pageNumber > 1;
    res.locals.newerActivityURL = url(pageNumber - 1);
    res.locals.recentActivity = withTimes(recentActivity);
  } catch (err) {
    console.log(err);
  }

  next();
};

module.exports.parseFileStatus = parseFileStatus;
