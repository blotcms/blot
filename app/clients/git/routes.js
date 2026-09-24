var authenticate = require("./authenticate");
var create = require("./create");
var database = require("./database");
var disconnect = require("./disconnect");
var pushover = require("pushover");
var sync = require("./sync");
var dataDir = require("./dataDir");
var Blog = require("models/blog");
var debug = require("debug")("blot:clients:git:routes");
var repos = pushover(dataDir, { autoCreate: false });
repos.on("error", function (err) {
  if (err && (err.code === "ECONNRESET" || err.code === "EPIPE")) {
    return debug("Git repos connection error", err.message || err);
  }

  debug("Git repos error", err);
});
var Express = require("express");
var dashboard = Express.Router();
var site = Express.Router();
var clfdate = require("helper/clfdate");
var host = require("config").host;

dashboard.get("/", function (req, res, next) {
  repos.exists(req.blog.handle + ".git", function (exists) {
    if (exists) {
      res.locals.repo = true;
      return next();
    }

    res.redirect(req.baseUrl + "/create");
  });
});

dashboard.get("/", function (req, res) {
  database.getRecordForBlog(req.blog, function (err, record) {
    database.getToken(req.blog.owner, function (err, token) {
      var status = record && record.status;
      res.render(__dirname + "/views/index.html", {
        title: "Git",
        token: token,
        createFailed: status === database.STATUSES.CREATE_FAILED,
        createInProgress: status === database.STATUSES.CREATE_IN_PROGRESS,
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
var GIT_REQUEST = /^(?![^#]*%(?:2[fF]|5[cC]))\/end(\/([a-z0-9]{2,70})\.git\/(?:info\/refs|HEAD|git-(?:upload|receive)-pack)(?:\?[^#]*)?)$/;

function parseGitRequest(req, res, next) {
  var match = GIT_REQUEST.exec(req.url);

  if (!match) return res.sendStatus(404);

  req.url = match[1];
  req.gitHandle = match[2];
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
        "/end" +
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

function finishedAllSyncs(blogID) {
  return activeSyncs[blogID] === 0;
}

// Used for testing purposes only to determine when a sync has finished
// Redlock means we can't reliably determine this just by calling
// Blot.sync();
site.get("/syncs-finished/:blogID", function (req, res) {
  res.send(finishedAllSyncs(req.params.blogID));
});

repos.on("push", function (push) {
  if (push) {
    push.on("error", function (err) {
      if (err && (err.code === "ECONNRESET" || err.code === "EPIPE")) {
        return debug("Git push error", err.message || err);
      }

      debug("Git push unexpected error", err);
    });
  }

  if (push && push.request) {
    push.request.on("error", function (err) {
      if (err && (err.code === "ECONNRESET" || err.code === "EPIPE")) {
        return debug("Git push request connection error", err.message || err);
      }

      debug("Git push request error", err);
    });

    push.request.on("aborted", function () {
      debug("Git push request aborted");
    });
  }

  if (push && push.response) {
    push.response.on("error", function (err) {
      if (err && (err.code === "ECONNRESET" || err.code === "EPIPE")) {
        return debug("Git push response connection error", err.message || err);
      }

      debug("Git push response error", err);
    });
  }

  if (push && push.branch && push.branch !== "master") {
    return push.reject(
      400,
      "Push rejected: only the master branch is allowed. Please push to master or open a PR."
    );
  }

  push.accept();

  // This might cause an interesting race condition. It happened for me during
  // testing. If we invoke Blog.Sync right now, it should be fine but previously
  // I had an additional asynchronous database lookup to fetch the full blog. I
  // believe this triggered issues in testing, because the test checked to see
  // if a sync had finished that had not actually yet begun. Perhaps we should
  // begin the sync on the "send" event instead of the "finish" event? That
  // might give us a firmer guarantee that the order of events is correct. This
  // seems to be purely a problem for automated use of the git client, humans
  // are unlikely to fire off multiple pushes immediately after the other.
  push.response.on("finish", function () {
    // I'm not sure what happens to lead to this being invoked
    // without a request or blog but it do sometimes.
    if (!push || !push.request || !push.request.blog)
      return debug("No blog found for push", push);

    // Used for testing purposes only
    started(push.request.blog.id);

    sync(push.request.blog.id, push.request.gitHandle, function (err) {
      // Used for testing purposes only
      finished(push.request.blog.id);

      if (err) {
        debug(err);
      } else {
        debug("Sync completed successfully!");
      }
    });
  });
});

// We need to pause then resume for some strange reason. See Pushover issue #30.
// Keep req.url untouched: Pushover uses the canonical repository path parsed
// and authenticated above to select the repository.
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

  req.pause();
  repos.handle(req, res);
  req.resume();
});

module.exports = { dashboard: dashboard, site: site, repos: repos };
