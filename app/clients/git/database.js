var database = {};
var client = require("models/client");
var debug = require("debug")("blot:clients:git:database");
var health = require("clients/health");
var { MESSAGES } = require("./error");

// I picked v4 from 5 possible versions
// because it said random next to its name?
var { v4: uuid } = require("uuid");

var STATUSES = {
  CREATE_IN_PROGRESS: "createInProgress",
  CREATE_COMPLETE: "createComplete",
  CREATE_FAILED: "createFailed",
};

function tokenKey(user_id) {
  return "user:" + user_id + ":git:token";
}

// Historically this was keyed on the user (`user:<uid>:git:status`), so a
// person with two Git sites shared one createFailed/createInProgress flag,
// and disconnect (which passed blog.id) never cleared it. Per-blog keys
// match every other client. getRecordForBlog still reads the legacy key.
function statusKey(blogID) {
  return "blog:" + blogID + ":git:status";
}

function legacyStatusKey(user_id) {
  return "user:" + user_id + ":git:status";
}

function parseRecord(raw) {
  if (raw == null || raw === "") return null;

  try {
    var parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (parsed.status || parsed.issue) return parsed;
    }
  } catch (e) {}

  return { status: String(raw) };
}

function generateToken() {
  return uuid().replace(/-/g, "");
}

function createToken(user_id, callback) {
  var new_token = generateToken();

  debug("User:", user_id, "Creating token if none exists");

  (async function () {
    try {
      var created = await client.setNX(tokenKey(user_id), new_token);

      // Preserve legacy setnx callback semantics (1: created, 0: existed)
      if (typeof created === "boolean") created = created ? 1 : 0;

      callback(null, created);
    } catch (err) {
      callback(err);
    }
  })();
}

function refreshToken(user_id, callback) {
  var new_token = generateToken();

  debug("User:", user_id, "Refreshing token");

  (async function () {
    try {
      await client.set(tokenKey(user_id), new_token);

      debug("User:", user_id, "Set token successfully");

      return callback(null, new_token);
    } catch (err) {
      return callback(err);
    }
  })();
}

function checkToken(user_id, token, callback) {
  debug("User:", user_id, "Checking token");

  getToken(user_id, function (err, valid_token) {
    if (err) return callback(err);

    return callback(null, token === valid_token);
  });
}

function flush(user_id, callback) {
  debug("User:", user_id, "Getting token");

  (async function () {
    try {
      await client.del(tokenKey(user_id));

      debug("User:", user_id, "Flushed token");

      return callback(null);
    } catch (err) {
      return callback(err);
    }
  })();
}

function getToken(user_id, callback) {
  debug("User:", user_id, "Getting token");

  (async function () {
    try {
      var token = await client.get(tokenKey(user_id));
      return callback(null, token);
    } catch (err) {
      return callback(err);
    }
  })();
}

function loadRaw(key, callback) {
  (async function () {
    try {
      var raw = await client.get(key);
      return callback(null, raw);
    } catch (err) {
      return callback(err);
    }
  })();
}

function getRecord(blogID, callback) {
  loadRaw(statusKey(blogID), function (err, raw) {
    if (err) return callback(err);
    callback(null, parseRecord(raw));
  });
}

function getLegacyRecord(user_id, callback) {
  loadRaw(legacyStatusKey(user_id), function (err, raw) {
    if (err) return callback(err);
    callback(null, parseRecord(raw));
  });
}

function getRecordForBlog(blog, callback) {
  if (!blog || !blog.id) return callback(new Error("No blog"));

  getRecord(blog.id, function (err, record) {
    if (err || record) return callback(err, record);
    if (!blog.owner) return callback(null, null);
    getLegacyRecord(blog.owner, callback);
  });
}

function saveRecord(blogID, record, callback) {
  (async function () {
    try {
      var result = await client.set(statusKey(blogID), JSON.stringify(record));
      return callback(null, result);
    } catch (err) {
      return callback(err);
    }
  })();
}

function setIssueOnRecord(record, issue) {
  var code = issue && issue.code;
  var same = record.issue && record.issue.code === code;
  var since = issue && issue.since;

  if (typeof since !== "number" || !isFinite(since)) {
    since = same && typeof record.issue.since === "number"
      ? record.issue.since
      : Date.now();
  }

  record.issue = {
    code: code,
    message: issue.message,
    since: since,
  };

  return record;
}

function setStatus(blogID, status, callback) {
  getRecord(blogID, function (err, record) {
    if (err) return callback(err);

    record = record || {};
    record.status = status;
    record.statusSince = Date.now();

    if (
      status === STATUSES.CREATE_IN_PROGRESS ||
      status === STATUSES.CREATE_COMPLETE
    ) {
      delete record.issue;
    } else if (status === STATUSES.CREATE_FAILED) {
      setIssueOnRecord(record, {
        code: health.CODES.SYNC_ERROR,
        message: MESSAGES.SETUP_FAILED,
        since: record.statusSince,
      });
    }

    saveRecord(blogID, record, callback);
  });
}

function getStatus(blogID, callback) {
  getRecord(blogID, function (err, record) {
    if (err) return callback(err);
    callback(null, record ? record.status : null);
  });
}

function setIssue(blogID, issue, callback) {
  getRecord(blogID, function (err, record) {
    if (err) return callback(err);
    saveRecord(blogID, setIssueOnRecord(record || {}, issue), callback);
  });
}

function clearIssue(blogID, callback) {
  getRecord(blogID, function (err, record) {
    if (err) return callback(err);
    if (!record || !record.issue) return callback(null);
    delete record.issue;
    saveRecord(blogID, record, callback);
  });
}

function removeStatus(blogID, callback) {
  (async function () {
    try {
      var removed = await client.del(statusKey(blogID));
      return callback(null, removed);
    } catch (err) {
      return callback(err);
    }
  })();
}

function removeLegacyStatus(user_id, callback) {
  (async function () {
    try {
      var removed = await client.del(legacyStatusKey(user_id));
      return callback(null, removed);
    } catch (err) {
      return callback(err);
    }
  })();
}

database.createToken = createToken;
database.checkToken = checkToken;
database.getToken = getToken;

database.flush = flush;
database.refreshToken = refreshToken;

database.STATUSES = STATUSES;
database.statusKey = statusKey;
database.legacyStatusKey = legacyStatusKey;
database.parseRecord = parseRecord;

database.setStatus = setStatus;
database.getStatus = getStatus;
database.getRecord = getRecord;
database.getRecordForBlog = getRecordForBlog;
database.setIssue = setIssue;
database.clearIssue = clearIssue;
database.removeStatus = removeStatus;
database.removeLegacyStatus = removeLegacyStatus;

module.exports = database;
