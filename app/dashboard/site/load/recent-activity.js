const Blog = require("models/blog");
const moment = require("moment");
const Path = require("path");
const { promisify } = require("util");

const getStatuses = promisify(Blog.getStatuses);
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
const STATUS_HISTORY_PAGE_SIZE = 2000;
const MAX_RECENT_GROUPS = 20;
const MAX_VISIBLE_FILES_PER_GROUP = 8;

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

module.exports = async function (req, res, next) {
  if (!req.blog.client) {
    res.locals.recentActivity = [];
    return next();
  }

  try {
    const { statuses } = await getStatuses(req.blog.id, {
      pageSize: STATUS_HISTORY_PAGE_SIZE,
    });
    const groups = new Map();

    statuses.forEach(function (status, index) {
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
          time: moment(date).fromNow(),
          datetime: moment(date).toISOString(),
          files: [],
          totalFiles: 0,
        };
        groups.set(key, group);
      }

      group.totalFiles++;
      group.files.push({
        verb: operation.verb,
        path: Path.posix.normalize(path),
        urlPath: path
          .replace(/^\/+/, "")
          .split("/")
          .map(encodeURIComponent)
          .join("/"),
      });
    });

    res.locals.recentActivity = Array.from(groups.values()).slice(
      0,
      MAX_RECENT_GROUPS
    );
    res.locals.recentActivity.forEach(function (group) {
      group.files.forEach(function (file, index) {
        file.isCollapsed = index >= MAX_VISIBLE_FILES_PER_GROUP;
      });
      group.moreFiles = Math.max(
        0,
        group.files.length - MAX_VISIBLE_FILES_PER_GROUP
      );
    });
    next();
  } catch (err) {
    console.log(err);
    res.locals.recentActivity = [];
    next();
  }
};

module.exports.parseFileStatus = parseFileStatus;
