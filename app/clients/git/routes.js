var authenticate = require("./authenticate");
var create = require("./create");
var database = require("./database");
var disconnect = require("./disconnect");
var repo = require("./repo");
var sync = require("./sync");
var Blog = require("models/blog");
var debug = require("debug")("blot:clients:git:routes");
var Express = require("express");
var dashboard = Express.Router();
var site = Express.Router();
var clfdate = require("helper/clfdate");
var followUpSync = require("clients/util/followUpSync");
var host = require("config").host;

// Syncs a blog after a push, or leaves a follow-up for any process to run
// once a sync already running (here or in another container) has finished.
// The blog's current handle is its repository's name: pushes to an old
// handle are redirected before they get this far.
var followUps = followUpSync("git", function (blogID) {
  return new Promise(function (resolve, reject) {
    Blog.get({ id: blogID }, function (err, blog) {
      if (err) return reject(err);
      if (!blog) return resolve();
      sync(blogID, blog.handle, function (err) {
        if (err) return reject(err);
        resolve();
      });
    });
  });
});

// Whether the blog has a repository, or one is being made for it
function hasRepository(blog, callback) {
  database.getStatus(blog.owner, function (err, status) {
    if (err) return callback(err);
    if (status === "createInProgress") return callback(null, true);

    repo.exists(blog.id, callback);
  });
}

dashboard.get("/", function (req, res, next) {
  hasRepository(req.blog, function (err, exists) {
    if (err) return next(err);

    if (exists) {
      res.locals.repo = true;
      return next();
    }

    res.redirect(req.baseUrl + "/create");
  });
});

dashboard.get("/", function (req, res) {
  database.getStatus(req.blog.owner, function (err, status) {
    database.getToken(req.blog.owner, function (err, token) {
      res.render(__dirname + "/views/index.html", {
        title: "Git",
        token: token,
        createFailed: status === 'createFailed',
        createInProgress: status === 'createInProgress',
        host,
      });
    });
  });
});

dashboard.get("/create", function (req, res) {
  res.locals.breadcrumbs.add("Git", "git");
  res.render(__dirname + "/views/create.html", {
    title: "Git",
  });
});

dashboard.post("/create", function (req, res, next) {
  
  if (req.body.cancel) {
    console.log(clfdate() + " Git: User cancelled creation of repo");

    if (!req.blog.client) {
      return res.redirect(res.locals.dashboardBase + "/client");
    }

    return disconnect(req.blog.id, next);
  }

  // A repository the blog already has, or one still being made: setup would
  // refuse a store which is not empty, and a second setup would race the
  // first
  hasRepository(req.blog, function (err, exists) {
    if (err) return next(err);

    if (exists) {
      console.log(clfdate() + " Git: Refused to create over repo for blog", req.blog.id);
      return res.message(
        req.baseUrl + "/create",
        new Error("A Git repository already exists for this username. Please contact us.")
      );
    }

    Blog.set(req.blog.id, { client: "git" }, function (err) {
      if (err) return next(err);

      res.redirect(req.baseUrl);

      create(req.blog, function (err) {
        if (err) {
          console.log(clfdate() + " Git: Error creating repo", err);
        }
      });
    });
  });
});

dashboard.get("/reset-password", function (req, res) {
  res.render(__dirname + "/views/reset-password.html", {
    title: "Git",
  });
});

dashboard.post("/reset-password", function (req, res, next) {
  database.refreshToken(req.blog.owner, function (err) {
    if (err) return next(err);
    res.redirect(req.baseUrl);
  });
});

dashboard.get("/disconnect", function (req, res) {
  res.locals.breadcrumbs.add("Disconnect", "disconnect");
  res.render(__dirname + "/views/disconnect.html", {
    title: "Git",
  });
});

dashboard.post("/disconnect", function (req, res, next) {
  req.blog.client = "";
  disconnect(req.blog.id, next);
});

// Parse the literal /end prefix while this router can still see it. Mounting a
// handler at /end first would let Express consume one optional slash, making
// /end//handle.git indistinguishable from /end/handle.git. Blog handles are
// canonical lowercase alphanumerics between 2 and 70 characters (the same
// shape stored by the blog model).
var GIT_REQUEST = /^(?![^#]*%(?:2[fF]|5[cC]))\/(end)(\/([a-z0-9]{2,70})\.git\/(?:info\/refs|HEAD|git-(?:upload|receive)-pack)(?:\?[^#]*)?)$/;

function parseGitRequest(req, res, next) {
  var match = GIT_REQUEST.exec(req.url);

  if (!match) return res.sendStatus(404);

  req.gitRoute = match[1];
  req.url = match[2];
  req.gitHandle = match[3];
  next();
}

function redirectRenamedGitHandle(req, res, next) {
  // Historical-to-current handle mappings are public. Resolve them before
  // authentication so old Git remotes can discover their canonical URL.
  Blog.get({ handle: req.gitHandle }, function (err, blog) {
    if (err || !blog || blog.handle === req.gitHandle) return next();

    var oldRepository = "/" + req.gitHandle + ".git";
    var trailingPathAndQuery = req.url.slice(oldRepository.length);

    res.redirect(
      308,
      "https://" +
        host +
        req.baseUrl +
        "/" +
        req.gitRoute +
        "/" +
        blog.handle +
        ".git" +
        trailingPathAndQuery
    );
  });
}

// We keep a dictionary of synced blogs for testing
// purposes. There isn't an easy way to determine
// after pushing whether or not Blot has completed the
// sync of the blog's folder. This is because I can't
// work out how to do something asynchronous after we've
// accepted a push but before we've sent the response.
var activeSyncs = {};

function started(blogID) {
  if (activeSyncs[blogID] === undefined) activeSyncs[blogID] = 0;
  activeSyncs[blogID]++;
}

function finished(blogID) {
  activeSyncs[blogID]--;
}

// A push which is refused starts no sync, so there may never have been one
function finishedAllSyncs(blogID) {
  return !activeSyncs[blogID];
}

// Used for testing purposes only to determine when a sync has finished
// Redlock means we can't reliably determine this just by calling
// Blot.sync();
// A follow-up still queued in Redis counts as a sync to come.
site.get("/syncs-finished/:blogID", async function (req, res, next) {
  try {
    var blogID = req.params.blogID;
    res.send(finishedAllSyncs(blogID) && !(await followUps.pending(blogID)));
  } catch (err) {
    next(err);
  }
});

// The follow-up is written before the push is acknowledged (prepare), so a
// crash between the acknowledgement and the sync can't lose the push. Once
// the sync has run it takes the follow-up back.
repo.onPush(
  function (blogID, old, current, armed) {
    // Used for testing purposes only
    started(blogID);

    followUps.run(blogID, armed).then(
      function () {
        // Used for testing purposes only
        finished(blogID);
        debug("Sync finished");
      },
      function (err) {
        // Used for testing purposes only
        finished(blogID);
        debug(err);
      }
    );
  },
  {
    prepare: function (blogID) {
      return followUps.arm(blogID);
    },
    abandon: function (blogID, armed) {
      if (armed !== undefined) return followUps.alarm.cancelIf(blogID, armed);
    },
  }
);

// Keep req.url untouched: the canonical repository path parsed and
// authenticated above selects the repository.
site.use(parseGitRequest, redirectRenamedGitHandle, authenticate, function (req, res) {
  function endResponse() {
    if (res && !res.headersSent && !res.finished && !res.writableEnded) {
      try {
        res.end();
      } catch (err) {
        debug("Error ending git response", err);
      }
    }
  }

  req.on("error", function (err) {
    if (err && (err.code === "ECONNRESET" || err.code === "EPIPE")) {
      debug("Git request connection error", err.message || err);
    } else {
      debug("Git request error", err);
    }

    endResponse();
  });

  req.on("aborted", function () {
    debug("Git request aborted");
    endResponse();
  });

  res.on("error", function (err) {
    if (err && (err.code === "ECONNRESET" || err.code === "EPIPE")) {
      return debug("Git response connection error", err.message || err);
    }

    debug("Git response error", err);
  });

  repo.handleSmartHttp(req, res, req.blog.id, req.blog);
});

module.exports = { dashboard: dashboard, site: site };
