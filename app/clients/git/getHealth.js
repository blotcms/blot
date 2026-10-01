const { promisify } = require("util");
const fs = require("fs-extra");
const Blog = require("models/blog");
const health = require("clients/health");
const database = require("./database");
const dataDir = require("./dataDir");
const localPath = require("helper/localPath");
const { MESSAGES } = require("./error");

const getToken = promisify(database.getToken.bind(database));
const getRecordForBlog = promisify(database.getRecordForBlog.bind(database));

function getBlog(blogID) {
  return new Promise(function (resolve, reject) {
    Blog.get({ id: blogID }, function (err, blog) {
      if (err) return reject(err);
      if (!blog) return reject(new Error("No blog"));
      resolve(blog);
    });
  });
}

function maybeSince(value) {
  return typeof value === "number" && isFinite(value) ? value : undefined;
}

module.exports = async function getHealth(blogID) {
  const blog = await getBlog(blogID);
  const record = await getRecordForBlog(blog);

  if (record && record.status === database.STATUSES.CREATE_IN_PROGRESS) {
    return health.syncing();
  }

  const issues = [];
  const createFailed = record && record.status === database.STATUSES.CREATE_FAILED;

  if (createFailed) {
    const issue = {
      code: health.CODES.SYNC_ERROR,
      message:
        (record.issue && record.issue.message) || MESSAGES.SETUP_FAILED,
    };
    const since = maybeSince(
      (record.issue && record.issue.since) || record.statusSince
    );
    if (since !== undefined) issue.since = since;
    issues.push(issue);
  } else if (record && record.issue) {
    const issue = {
      code: record.issue.code,
      message: record.issue.message,
    };
    const since = maybeSince(record.issue.since);
    if (since !== undefined) issue.since = since;
    issues.push(issue);
  }

  const token = await getToken(blog.owner);
  if (!token) {
    issues.push({
      code: health.CODES.REAUTH_REQUIRED,
      message: MESSAGES.REAUTH_REQUIRED,
    });
  }

  const alreadyMissing = issues.some(function (item) {
    return item.code === health.CODES.SOURCE_MISSING;
  });

  if (!createFailed && !alreadyMissing) {
    const bareExists = await fs.pathExists(
      dataDir + "/" + blog.handle + ".git"
    );
    const liveGitExists = await fs.pathExists(localPath(blog.id, "/.git"));

    if (!bareExists || !liveGitExists) {
      issues.push({
        code: health.CODES.SOURCE_MISSING,
        message: MESSAGES.SOURCE_MISSING,
      });
    }
  }

  return health.error(issues);
};
