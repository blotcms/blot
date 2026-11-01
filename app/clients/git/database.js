var database = {};
var client = require("models/client");
var debug = require("debug")("blot:clients:git:database");

// I picked v4 from 5 possible versions
// because it said random next to its name?
var { v4: uuid } = require("uuid");

function tokenKey(user_id) {
  return "user:" + user_id + ":git:token";
}

function statusKey(user_id) {
  return "user:" + user_id + ":git:status";
}

// The commit whose changes Blot has applied to the blog's entries: the next
// sync diffs from it. Under blog:<id>: so deleting the blog removes it, and
// disconnecting removes it too.
function appliedKey(blogID) {
  return "blog:" + blogID + ":git:applied";
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

function setStatus(blogID, status, callback) {
  (async function () {
    try {
      var result = await client.set(statusKey(blogID), status);
      return callback(null, result);
    } catch (err) {
      return callback(err);
    }
  })();
}

function getStatus(blogID, callback) {
  (async function () {
    try {
      var status = await client.get(statusKey(blogID));
      return callback(null, status);
    } catch (err) {
      return callback(err);
    }
  })();
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

function getApplied(blogID, callback) {
  (async function () {
    try {
      return callback(null, (await client.get(appliedKey(blogID))) || null);
    } catch (err) {
      return callback(err);
    }
  })();
}

function setApplied(blogID, commit, callback) {
  (async function () {
    try {
      await client.set(appliedKey(blogID), commit);
      return callback(null);
    } catch (err) {
      return callback(err);
    }
  })();
}

// Sets the commit only if there is none yet. Calls back with true if it did.
function setAppliedIfMissing(blogID, commit, callback) {
  (async function () {
    try {
      var created = await client.setNX(appliedKey(blogID), commit);
      return callback(null, !!created);
    } catch (err) {
      return callback(err);
    }
  })();
}

// Moves the commit from one value to the next, unless something else has
// moved it since. Blot's own commit does this while a sync may be applying a
// push, and a plain read then write could set it back over the sync's newer
// value, so this is the one compare-then-set that is a script. Calls back
// with true if it moved.
function advanceApplied(blogID, from, to, callback) {
  (async function () {
    try {
      var moved = await client.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]) return 1 end return 0",
        { keys: [appliedKey(blogID)], arguments: [from, to] }
      );
      return callback(null, moved === 1);
    } catch (err) {
      return callback(err);
    }
  })();
}

function removeApplied(blogID, callback) {
  (async function () {
    try {
      await client.del(appliedKey(blogID));
      return callback(null);
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

database.setStatus = setStatus;
database.getStatus = getStatus;
database.removeStatus = removeStatus;

database.getApplied = getApplied;
database.setApplied = setApplied;
database.setAppliedIfMissing = setAppliedIfMissing;
database.advanceApplied = advanceApplied;
database.removeApplied = removeApplied;

module.exports = database;
