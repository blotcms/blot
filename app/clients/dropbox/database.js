var debug = require("debug")("blot:clients:dropbox:database");
var redis = require("models/client");
var Blog = require("models/blog");
var ensure = require("helper/ensure");
var Model;

function defaultFor(type) {
  if (type === "number") return 0;
  if (type === "boolean") return false;
  return "";
}

async function getAccount(blogID) {
  var account = await redis.hGetAll(accountKey(blogID));

  if (!account || !Object.keys(account).length) return null;

  // Restore the types of the properties
  // of the account object before returning.
  // Missing keys (e.g. fields added after the row was written) get
  // a typed default so a later set() still satisfies the model.
  for (var i in Model) {
    if (account[i] === undefined || account[i] === null) {
      account[i] = defaultFor(Model[i]);
      continue;
    }

    if (Model[i] === "number") {
      var n = parseInt(account[i], 10);
      account[i] = isFinite(n) ? n : 0;
    }

    if (Model[i] === "boolean") account[i] = account[i] === "true";
  }

  return account;
}

function get(blogID, callback) {
  getAccount(blogID)
    .then(function (account) {
      return callback(null, account);
    })
    .catch(function (err) {
      return callback(err, null);
    });
}

async function listAccountBlogs(account_id) {
  var blogs = [];

  debug("Getting blogs conencted to Dropbox account", account_id);

  var members = await redis.sMembers(blogsKey(account_id));

  debug("Found these blog IDs", members);

  await Promise.all(
    members.map(function (id) {
      return new Promise(function (resolve) {
        Blog.get({ id: id }, function (err, blog) {
          if (err) {
            debug("Error loading blog", id, err);
            return resolve();
          }

          if (blog && blog.client === "dropbox") {
            blogs.push(blog);
          } else {
            debug(id, "does not match an extant blog using the Dropbox client.");
          }

          resolve();
        });
      });
    })
  );

  return blogs;
}

function listBlogs(account_id, callback) {
  listAccountBlogs(account_id)
    .then(function (blogs) {
      callback(null, blogs);
    })
    .catch(function (err) {
      callback(err);
    });
}

async function setAccount(blogID, changes) {
  var multi = redis.multi();

  debug("Setting dropbox account info for blog", blogID);

  var account = await getAccount(blogID);

  // When saving account for the first time,
  // this will be null so we make a fresh object.
  account = account || {};

  // We need to do this to prevent bugs if
  // the user switches from one account ID
  // to another Dropbox account.
  if (
    account.account_id &&
    changes.account_id &&
    account.account_id !== changes.account_id
  ) {
    multi.sRem(blogsKey(account.account_id), blogID);
  }

  // Overwrite existing properties with any changes
  for (var i in changes) account[i] = changes[i];

  // transfer_pending was added to the model after this file already had
  // callers (including plenty of existing tests) that write a brand new
  // account without mentioning it. ensure()'s strict check below requires
  // every model field to already be present with the right type, so default
  // it here rather than requiring every caller to pass it explicitly. Any
  // caller that actually wants it true still overrides it via `changes`.
  if (typeof account.transfer_pending !== "boolean") {
    account.transfer_pending = false;
  }

  // A successful sync writes error_code: 0; drop the source/since that
  // belonged to a previous failure so they cannot linger on the row.
  if (account.error_code === 0) {
    account.error_source = "";
    account.error_since = 0;
  }

  // Rows written before these fields existed, or a first save from
  // setup, do not carry them. Every other field stays required.
  ["error_source", "error_since"].forEach(function (field) {
    if (account[field] === undefined || account[field] === null) {
      account[field] = defaultFor(Model[field]);
    }
  });


  // Verify that the type of new account state
  // matches the expected types declared in Model below.
  ensure(account, Model, true);

  // Redis v5 does not accept booleans in hash writes.
  // Store everything as strings; getAccount restores types.
  var serialized = {};
  for (var field in account) {
    serialized[field] = String(account[field]);
  }

  debug("Saving this account");
  multi.sAdd(blogsKey(account.account_id), blogID);
  multi.hSet(accountKey(blogID), serialized);

  return multi.exec();
}

function set(blogID, changes, callback) {
  setAccount(blogID, changes)
    .then(function (result) {
      callback(null, result);
    })
    .catch(function (err) {
      callback(err);
    });
}

async function dropAccount(blogID) {
  var multi = redis.multi();
  var account = await getAccount(blogID);

  // Deregister this blog from the set containing
  // the blog IDs associated with a particular dropbox.
  if (account && account.account_id) {
    multi.sRem(blogsKey(account.account_id), blogID);
  }

  // Remove all the dangerous Dropbox account information
  // including the OAUTH token used to interact with
  // Dropbox's API.
  multi.del(accountKey(blogID));

  return multi.exec();
}

function drop(blogID, callback) {
  dropAccount(blogID)
    .then(function (result) {
      callback(null, result);
    })
    .catch(function (err) {
      callback(err);
    });
}

// Persist a classified Dropbox error. Repeating the same status+source
// keeps the original error_since so getHealth can report when the issue
// first appeared rather than the last time we noticed it.
function setError(blogID, classification, callback) {
  if (!classification || !classification.persist) {
    return callback(null);
  }

  get(blogID, function (err, account) {
    if (err) return callback(err);
    if (!account) return callback(null);

    var same =
      account.error_code === classification.status &&
      account.error_source === classification.source;

    set(
      blogID,
      {
        error_code: classification.status || 0,
        error_source: classification.source || "",
        error_since:
          same && account.error_since ? account.error_since : Date.now(),
      },
      callback
    );
  });
}

// Redis Hash which stores the Dropbox account info
function accountKey(blogID) {
  return "blog:" + blogID + ":dropbox:account";
}

// Redis set whoses members are the blog IDs
// connected to this dropbox account.
function blogsKey(account_id) {
  return "clients:dropbox:" + account_id;
}

Model = {
  // Used to identify which blogs need to be updated
  // when we recieve a webhook from Dropbox
  account_id: "string",

  // Used to help the user identify which
  // Dropbox account is connected to which blog.
  email: "string",

  // Used to authenticate Dropbox API requests
  access_token: "string",

  // Used to generate new access tokens
  refresh_token: "string",

  // HTTP status code of an error from the
  // Dropbox API. Will be 0 if sync succeeded.
  // Only user-actionable failures are stored
  // (401, delta 409, 507); transients stay 0.
  error_code: "number",

  // Which sync step produced error_code: "auth",
  // "delta", or "apply". Empty when healthy. A 409
  // is SOURCE_MISSING only when this is "delta".
  error_source: "string",

  // ms epoch when the current error_code first
  // appeared. 0 when healthy.
  error_since: "number",

  // Date stamp of the last successful sync
  last_sync: "number",

  // true if Blot has full access to the user's
  // Dropbox folder, false if we only have
  // access to a folder in their Apps folder
  full_access: "boolean",

  // Used to help the user identify which
  // Dropbox account is connected to which blog.
  // We use to more dependable folder_id
  // in calls to /delta and for determining
  // which changes apply to this blog. Root
  // should be an empty string.
  folder: "string",

  // Generated by Dropbox and used to robustly
  // identify a folder even after it has been
  // renamed. Empty string if the user has set
  // the root directory of their Dropbox.
  folder_id: "string",

  // Generated by Dropbox and used to fetch
  // changes which occur after a certain point
  // in time. When the user sets up Dropbox,
  // this is an empty string.
  cursor: "string",

  // True from the moment setup (routes/setup/index.js) starts the initial
  // transfer of the blog's existing folder to Dropbox, until reset-from-blot.js
  // finishes uploading every file and clears it back to false in the same
  // write that sets error_code: 0 and the cursor. While true, Dropbox cannot
  // be trusted as the source of truth for this blog: resetToBlot (and the
  // webhook-driven sync in sync/index.js) delete any local file with no
  // Dropbox counterpart, which is exactly the files that haven't been
  // uploaded yet. See util/constants.js's transferIncomplete() - every
  // automatic path that could run one of those destructive syncs (startup
  // resync, hourly validation, webhook sync) checks it first and skips the
  // blog while this is true. A pre-existing account's hash predates this
  // field; getAccount() below defaults a missing boolean field to false, so
  // old accounts are unaffected.
  transfer_pending: "boolean",
};

module.exports = {
  set,
  setError,
  drop,
  get,
  listBlogs,
};
