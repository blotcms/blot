var debug = require("debug")("blot:clients:onedrive:database");
var redis = require("models/client");
var Blog = require("models/blog");
var ensure = require("helper/ensure");
var Model;

async function getAccount(blogID) {
  var account = await redis.hGetAll(accountKey(blogID));

  if (!account || !Object.keys(account).length) return null;

  // Restore the types of the properties
  // of the account object before returning.
  for (var i in Model) {
    if (Model[i] === "number") account[i] = parseInt(account[i]);
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

  var members = await redis.sMembers(blogsKey(account_id));

  await Promise.all(
    members.map(function (id) {
      return new Promise(function (resolve) {
        Blog.get({ id: id }, function (err, blog) {
          if (err) {
            debug("Error loading blog", id, err);
            return resolve();
          }

          if (blog && blog.client === "onedrive") blogs.push(blog);

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

  debug("Setting OneDrive account info for blog", blogID);

  var account = (await getAccount(blogID)) || {};

  // Keep the account -> blogs index correct if the
  // user switches to a different Microsoft account.
  if (
    account.account_id &&
    changes.account_id &&
    account.account_id !== changes.account_id
  ) {
    multi.sRem(blogsKey(account.account_id), blogID);
  }

  // Overwrite existing properties with any changes
  for (var i in changes) account[i] = changes[i];

  // Verify that the type of new account state
  // matches the expected types declared in Model below.
  ensure(account, Model, true);

  // Redis does not accept numbers in hash writes,
  // so store strings; getAccount restores types.
  var serialized = {};
  for (var field in account) {
    serialized[field] = String(account[field]);
  }

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

  if (account && account.account_id) {
    multi.sRem(blogsKey(account.account_id), blogID);
  }

  // Removes the OAuth tokens
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

// Redis Hash which stores the OneDrive account info
function accountKey(blogID) {
  return "blog:" + blogID + ":onedrive:account";
}

// Redis set whose members are the blog IDs
// connected to this Microsoft account.
function blogsKey(account_id) {
  return "clients:onedrive:" + account_id;
}

Model = {
  // Microsoft account ID from Graph's /me, used to find which blogs
  // belong to an account.
  account_id: "string",

  // Shown on the dashboard to identify which account is connected.
  email: "string",

  // Used to authenticate Microsoft Graph requests
  access_token: "string",

  // Used to get new access tokens. Rotated by Microsoft on every use.
  refresh_token: "string",

  // Epoch ms after which access_token is no longer valid.
  expires_at: "number",

  // HTTP-style status code of an error talking to Microsoft. 0 if OK,
  // 401 if the refresh token was rejected and the user must reconnect.
  error_code: "number",
};

module.exports = {
  set,
  drop,
  get,
  listBlogs,
};
