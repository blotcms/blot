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
var followUps = followUpSync("git", async function (blogID) {
  var blog = await Blog.get({ id: blogID });

  if (!blog) return;

  await sync(blogID, blog.handle);
});

// Whether the blog has a repository in the store, or one is being set up for
// it: the blog's own mark, set by create.js, which expires by itself, so a
// setup cut off by a crash or a deploy doesn't leave the blog, or the owner's
// other blogs, stuck "in progress"
async function hasRepository(blog) {
  if (await repo.exists(blog.id)) return true;

  return await database.isCreating(blog.id);
}

dashboard.get("/", async function (req, res, next) {
  var exists;

  try {
    exists = await hasRepository(req.blog);
  } catch (err) {
    return next(err);
  }

  if (exists) {
    res.locals.repo = true;
    return next();
  }

  res.redirect(req.baseUrl + "/create");
});

dashboard.get("/", async function (req, res, next) {
  // A failed lookup renders the page without it, as before
  var status, token;

  try {
    status = await database.getStatus(req.blog.owner);
  } catch (err) {
    status = undefined;
  }

  try {
    token = await database.getToken(req.blog.owner);
  } catch (err) {
    token = undefined;
  }

  try {
    res.render(__dirname + "/views/index.html", {
      title: "Git",
      token: token,
      createFailed: status === "createFailed",
      createInProgress: status === "createInProgress",
      host,
    });
  } catch (err) {
    next(err);
  }
});

dashboard.get("/create", function (req, res) {
  res.locals.breadcrumbs.add("Git", "git");
  res.render(__dirname + "/views/create.html", {
    title: "Git",
  });
});

dashboard.post("/create", async function (req, res, next) {
  try {
    if (req.body.cancel) {
      console.log(clfdate() + " Git: User cancelled creation of repo");

      if (!req.blog.client) {
        return res.redirect(res.locals.dashboardBase + "/client");
      }

      await disconnect(req.blog.id);
      return next();
    }

    // A repository the blog already has, or one still being made: setup would
    // refuse a store which is not empty, and a second setup would race the
    // first
    if (await hasRepository(req.blog)) {
      console.log(
        clfdate() + " Git: Refused to create over repo for blog",
        req.blog.id
      );
      return res.message(
        req.baseUrl + "/create",
        new Error(
          "A Git repository already exists for this username. Please contact us."
        )
      );
    }

    await Blog.set(req.blog.id, { client: "git" });

    // Marked before the redirect, so the page it lands on shows the setup
    // (create.js marks it too, and clears it when the setup ends). A failure
    // to mark it does not stop the setup.
    try {
      await database.setCreating(req.blog.id);
    } catch (err) {
      // Ignored
    }

    res.redirect(req.baseUrl);

    create(req.blog).catch(function (err) {
      console.log(clfdate() + " Git: Error creating repo", err);
    });
  } catch (err) {
    next(err);
  }
});

dashboard.get("/reset-password", function (req, res) {
  res.render(__dirname + "/views/reset-password.html", {
    title: "Git",
  });
});

dashboard.post("/reset-password", async function (req, res, next) {
  try {
    await database.refreshToken(req.blog.owner);
    res.redirect(req.baseUrl);
  } catch (err) {
    next(err);
  }
});

dashboard.get("/disconnect", function (req, res) {
  res.locals.breadcrumbs.add("Disconnect", "disconnect");
  res.render(__dirname + "/views/disconnect.html", {
    title: "Git",
  });
});

dashboard.post("/disconnect", async function (req, res, next) {
  req.blog.client = "";

  try {
    await disconnect(req.blog.id);
  } catch (err) {
    return next(err);
  }

  next();
});

// Parse the literal /end prefix while this router can still see it. Mounting a
// handler at /end first would let Express consume one optional slash, making
// /end//handle.git indistinguishable from /end/handle.git. Blog handles are
// canonical lowercase alphanumerics between 2 and 70 characters (the same
// shape stored by the blog model).
var GIT_REQUEST =
  /^(?![^#]*%(?:2[fF]|5[cC]))\/(end)(\/([a-z0-9]{2,70})\.git\/(?:info\/refs|HEAD|git-(?:upload|receive)-pack)(?:\?[^#]*)?)$/;

function parseGitRequest(req, res, next) {
  var match = GIT_REQUEST.exec(req.url);

  if (!match) return res.sendStatus(404);

  req.gitRoute = match[1];
  req.url = match[2];
  req.gitHandle = match[3];
  next();
}

async function redirectRenamedGitHandle(req, res, next) {
  // Historical-to-current handle mappings are public. Resolve them before
  // authentication so old Git remotes can discover their canonical URL.
  var blog;

  try {
    blog = await Blog.get({ handle: req.gitHandle });
  } catch (err) {
    return next();
  }

  if (!blog || blog.handle === req.gitHandle) return next();

  var oldRepository = "/" + req.gitHandle + ".git";
  var trailingPathAndQuery = req.url.slice(oldRepository.length);

  try {
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
  } catch (err) {
    next(err);
  }
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
site.use(
  parseGitRequest,
  redirectRenamedGitHandle,
  authenticate,
  function (req, res) {
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
  }
);

module.exports = { dashboard: dashboard, site: site };
