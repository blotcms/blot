var eachBlog = require("../each/blog");
var progress = require("../each/progress");
var async = require("async");
var Mustache = require("mustache");
var Template = require("models/template");
var templateKey = require("models/template/key");
var redis = require("models/client");
var Blog = require("models/blog");
var parseTemplate = require("models/template/parseTemplate");
var applyUserRetrieveOptions = require("models/template/util/applyUserRetrieveOptions");
var updateCdnManifest = require("models/template/util/updateCdnManifest");

// How many blogs to process concurrently. 1 keeps the nested progress line
// accurate; raise it (via --concurrency=N) when the per-blog Redis reads are
// the bottleneck on a full-fleet run.
var DEFAULT_CONCURRENCY = 1;

// A retrieve write commits before its blog's cache is flushed. If the process
// stops (or a flush fails) in that window the metadata now looks current, so a
// re-run's equality check would skip the blog and never retry the flush. These
// keys record "this blog still needs a flush" so the next run drains them
// first. PENDING_FLUSH_KEY is a hash blogID -> JSON(changed template ids) for
// blog-owned templates (cacheID bump + manifest rebuild); PENDING_SITE_FLUSH
// is a plain set of blog ids that use a rewritten SITE template (cacheID bump
// only, matching invalidateBlogsUsing).
var PENDING_FLUSH_KEY = "template:recalculate-retrieve:pending-flush";
var PENDING_SITE_FLUSH_KEY = "template:recalculate-retrieve:pending-site-flush";

if (require.main === module) {
  var options = parseArgs(process.argv.slice(2));

  main(options, function (err, stats) {
    if (err) {
      console.error(err);
      process.exit(1);
    }

    console.log(
      options.dryRun ? "Dry run complete." : "Done.",
      options.dryRun ? "Would recalculate" : "Recalculated",
      "retrieve metadata for",
      stats.updated,
      "views",
      "(skipped",
      stats.skipped,
      "invalid,",
      stats.alreadyMigrated,
      "already current)"
    );

    if (stats.recovered) {
      console.log(
        "Recovered",
        stats.recovered,
        "pending cache flush(es) from a previous run"
      );
    }

    if (stats.errors.length) {
      console.error("\n" + stats.errors.length + " error(s):");
      stats.errors.forEach(function (e) {
        var where = [e.blogID, e.templateID, e.viewName].filter(Boolean).join(" / ");
        console.error("  -", where || "(global)", ":", e.error);
      });
      process.exit(1);
    }

    process.exit(0);
  });
}

function parseArgs(argv) {
  var options = { dryRun: false, concurrency: DEFAULT_CONCURRENCY };

  (argv || []).forEach(function (arg) {
    if (arg === "--dry-run" || arg === "-n") {
      options.dryRun = true;
    } else if (arg.indexOf("--concurrency=") === 0) {
      var n = parseInt(arg.slice("--concurrency=".length), 10);
      if (n > 0) options.concurrency = n;
    }
  });

  return options;
}

function recordError(stats, entry) {
  stats.errors.push(entry);
  var where = [entry.blogID, entry.templateID, entry.viewName]
    .filter(Boolean)
    .join(" / ");
  console.error("Error:", where || "(global)", "-", entry.error);
}

function main(options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }

  options = options || {};

  var dryRun = options.dryRun === true;
  var concurrency =
    options.concurrency > 0 ? options.concurrency : DEFAULT_CONCURRENCY;

  var stats = {
    updated: 0,
    skipped: 0,
    alreadyMigrated: 0,
    recovered: 0,
    errors: [],
  };

  // Blog-owned templates. Recalculate every view of every template, then, once
  // per blog whose templates actually changed, bump that blog's cacheID a
  // single time and rebuild the CDN manifest of each changed template.
  //
  // recalcView reparses each view in-process and only writes (just the
  // `retrieve` hash field) when the stored metadata differs from what the
  // parser now produces - so a view that is already current costs one parse
  // and no Redis write, and a blog with nothing stale is never flushed.
  //
  // Per-blog and per-view failures are collected in stats.errors and the run
  // continues: a single unreadable blog must not abort a fleet-wide migration,
  // and - with --concurrency > 1 - must not let async's eachLimit fire its
  // final callback (and the process exit) while other blogs are mid-write.
  function runIteration() {
    eachBlog(
      function (user, blog, nextBlog) {
        recalcBlog(blog.id, stats, dryRun, function () {
          nextBlog();
        });
      },
      function (err) {
        // Only a failure to enumerate blogs at all reaches here.
        if (err) return callback(err, stats);

        // Bundled SITE:* templates are used directly by blogs but are skipped
        // by scripts/each - iterate them explicitly so their views also pick
        // up field projection metadata.
        var touchedSiteTemplates = {};

        eachSiteView(
          function (templateID, view, next) {
            recalcView(templateID, view, stats, dryRun, function (vErr, changed) {
              if (changed) touchedSiteTemplates[templateID] = true;
              if (vErr)
                recordError(stats, {
                  templateID: templateID,
                  viewName: view && view.name,
                  error: "site view write: " + vErr.message,
                });
              next();
            });
          },
          function (err) {
            if (err)
              recordError(stats, {
                error: "SITE template iteration: " + err.message,
              });

            if (dryRun) return callback(null, stats);

            // Flush the full-view / rendered-output caches of every blog whose
            // active template we just rewrote so the new retrieve metadata
            // takes effect.
            invalidateBlogsUsing(
              Object.keys(touchedSiteTemplates),
              stats,
              function (flushErr) {
                if (flushErr)
                  recordError(stats, {
                    error: "SITE cache invalidation: " + flushErr.message,
                  });
                callback(null, stats);
              }
            );
          }
        );
      },
      { c: concurrency }
    );
  }

  if (dryRun) return runIteration();

  recoverPendingFlushes(stats, function (err) {
    if (err)
      recordError(stats, { error: "pending-flush recovery: " + err.message });
    runIteration();
  });
}

function recalcBlog(blogID, stats, dryRun, done) {
  Template.getTemplateList(blogID, function (err, templates) {
    if (err) {
      recordError(stats, { blogID: blogID, error: "getTemplateList: " + err.message });
      return done();
    }

    var owned = (templates || []).filter(function (template) {
      return template.owner === blogID;
    });

    var changedTemplateIDs = [];
    var bar = progress.push("Template", owned.length);

    async.eachSeries(
      owned,
      function (template, nextTemplate) {
        recalcTemplateViews(template.id, stats, dryRun, function (tErr, changed) {
          if (changed) changedTemplateIDs.push(template.id);
          if (tErr)
            recordError(stats, {
              blogID: blogID,
              templateID: template.id,
              error: tErr.message,
            });
          bar.tick();
          // Keep going: one bad template must not skip the blog's others, and
          // finalizeBlog still flushes whatever did change.
          nextTemplate();
        });
      },
      function () {
        bar.pop();

        if (dryRun) return done();

        finalizeBlog(blogID, changedTemplateIDs, function (flushErr) {
          if (flushErr)
            recordError(stats, {
              blogID: blogID,
              error: "finalize: " + flushErr.message,
            });
          done();
        });
      }
    );
  });
}

function recalcTemplateViews(templateID, stats, dryRun, done) {
  Template.getAllViews(templateID, function (err, views) {
    if (err) return done(err, false);

    var changed = false;
    var firstErr = null;
    var bar = progress.push("View", Object.keys(views || {}).length);

    async.eachOfSeries(
      views || {},
      function (view, name, nextView) {
        recalcView(templateID, view, stats, dryRun, function (err, viewChanged) {
          if (viewChanged) changed = true;
          if (err && !firstErr) firstErr = err;
          bar.tick();
          // Don't abort the template's remaining views on one failed write.
          nextView();
        });
      },
      function () {
        bar.pop();
        done(firstErr || null, changed);
      }
    );
  });
}

// Flush a blog's caches after its templates were recalculated. One cacheID
// bump invalidates every full-view / rendered cache entry for the blog -
// app/blog/render/full-view-cache.js keys on blog.cacheID, so this covers the
// active template and every preview-of-my-* template alike. Bump before
// rebuilding any manifest so updateCdnManifest renders CDN targets against the
// new cacheID, matching the order setView and clone use.
//
// The PENDING_FLUSH_KEY entry is written before the bump and cleared only once
// the manifest rebuilds finish, so a crash or failure anywhere in between is
// retried by recoverPendingFlushes on the next run.
function finalizeBlog(blogID, changedTemplateIDs, done) {
  if (!changedTemplateIDs || !changedTemplateIDs.length) return done();

  Promise.resolve(
    redis.hSet(PENDING_FLUSH_KEY, blogID, JSON.stringify(changedTemplateIDs))
  )
    .then(function () {
      // Re-read the blog: this script is long-running and the owner may have
      // switched active template while we worked through their other templates.
      Blog.get({ id: blogID }, function (err, blog) {
        if (err) return done(err);
        if (!blog) return clearPending();

        Blog.set(blogID, { cacheID: Date.now() }, function (err) {
          if (err) return done(err);

          console.log("Flushed cache for", blog.handle || blogID);

          // Rebuild the CDN manifest once per changed template.
          // updateCdnManifest no-ops for templates that aren't installed on
          // their owner blog, so an inactive template costs only a metadata
          // lookup here.
          async.eachSeries(
            changedTemplateIDs,
            function (templateID, next) {
              updateCdnManifest(templateID, next);
            },
            function (err) {
              if (err) return done(err);
              clearPending();
            }
          );
        });
      });
    })
    .catch(done);

  function clearPending() {
    Promise.resolve(redis.hDel(PENDING_FLUSH_KEY, blogID))
      .then(function () {
        done();
      })
      .catch(done);
  }
}

function recalcView(templateID, view, stats, dryRun, next) {
  if (!view || !view.name || !view.content) {
    stats.skipped++;
    return next(null, false);
  }

  // parseTemplate swallows a malformed-Mustache parse and just returns empty
  // metadata, so it can't tell us the content is broken. Match setView's own
  // guard (Mustache.render(content, {})) and leave a genuinely invalid view
  // untouched rather than writing metadata derived from a failed parse.
  try {
    Mustache.render(view.content, {});
  } catch (e) {
    console.error(
      "Skipping view with invalid Mustache",
      templateID,
      view.name,
      "-",
      e && e.message
    );
    stats.skipped++;
    return next(null, false);
  }

  var expectedRetrieve;

  try {
    var parsed = parseTemplate(view.content);
    // setView persists exactly applyUserRetrieveOptions(parser output, the
    // update's retrieve, the stored retrieve). The recalculation passes no
    // real retrieve options, so a full setView run would store precisely
    // this. Compute it here without any Redis round-trip.
    expectedRetrieve = applyUserRetrieveOptions(
      parsed.retrieve || {},
      undefined,
      view.retrieve && typeof view.retrieve === "object" ? view.retrieve : {}
    );
  } catch (e) {
    console.error(
      "Skipping view; retrieve computation failed",
      templateID,
      view.name,
      "-",
      e && e.message
    );
    stats.skipped++;
    return next(null, false);
  }

  // Only skip when the stored value is actually a retrieve object that already
  // matches. A legacy view whose hash omits `retrieve` (or stores null) is
  // materialised with an explicit object here - getFullView -> retrieve()
  // asserts an object, so leaving the field absent could break rendering.
  var stored = view.retrieve;
  var storedIsObject =
    !!stored && typeof stored === "object" && !Array.isArray(stored);

  if (
    storedIsObject &&
    stableStringify(expectedRetrieve) === stableStringify(stored)
  ) {
    stats.alreadyMigrated++;
    return next(null, false);
  }

  if (dryRun) {
    stats.updated++;
    console.log("Would update", templateID, view.name);
    return next(null, true);
  }

  // Only the parser-derived retrieve metadata is changing. Write just that
  // one hash field: no content validation, no infinite-partial detection, no
  // rewrite of the (potentially megabyte) content field, no per-view cacheID
  // bump. finalizeBlog / invalidateBlogsUsing flush the owner blog once.
  Promise.resolve(
    redis.hSet(
      templateKey.view(templateID, view.name),
      "retrieve",
      JSON.stringify(expectedRetrieve)
    )
  )
    .then(function () {
      stats.updated++;
      console.log("Updated", templateID, view.name);
      next(null, true);
    })
    .catch(function (err) {
      // The hSet is atomic - on failure nothing was written, so report the
      // view as unchanged. The error is surfaced via stats.errors.
      next(err, false);
    });
}

// Deterministic JSON: object keys sorted at every level so two structurally
// equal retrieve objects (parsed fresh vs. round-tripped through Redis)
// stringify identically. Array order is left alone - it is meaningful for
// `cdn`, which applyUserRetrieveOptions already sorts.
function stableStringify(value) {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce(function (acc, key) {
        acc[key] = sortKeysDeep(value[key]);
        return acc;
      }, {});
  }

  return value;
}

// Mirror app/templates/index.js:emptyCacheForBlogsUsing - bump the cacheID of
// every blog whose active template is one we just rewrote. Used for SITE:*
// templates, whose owner is the literal "SITE" so no real blog's cacheID is
// touched by the recalculation itself. Each blog id is recorded in
// PENDING_SITE_FLUSH_KEY before its bump and removed after, so a failed or
// interrupted flush is retried by recoverPendingFlushes.
function invalidateBlogsUsing(templateIDs, stats, done) {
  if (!templateIDs || !templateIDs.length) return done();

  var touched = {};
  templateIDs.forEach(function (id) {
    touched[id] = true;
  });

  Blog.getAllIDs(function (err, ids) {
    if (err) return done(err);

    async.eachSeries(
      ids || [],
      function (blogID, next) {
        Blog.get({ id: blogID }, function (err, blog) {
          if (err) {
            recordError(stats, {
              blogID: blogID,
              error: "SITE flush get: " + err.message,
            });
            return next();
          }
          if (!blog || !blog.template || !touched[blog.template]) return next();

          Promise.resolve(redis.sAdd(PENDING_SITE_FLUSH_KEY, blogID))
            .then(function () {
              Blog.set(blogID, { cacheID: Date.now() }, function (err) {
                if (err) {
                  recordError(stats, {
                    blogID: blogID,
                    error: "SITE flush set: " + err.message,
                  });
                  return next();
                }
                console.log("Flushed cache for", blog.handle || blogID);
                Promise.resolve(redis.sRem(PENDING_SITE_FLUSH_KEY, blogID))
                  .then(function () {
                    next();
                  })
                  .catch(function () {
                    next();
                  });
              });
            })
            .catch(function (markErr) {
              recordError(stats, {
                blogID: blogID,
                error: "SITE flush mark: " + markErr.message,
              });
              next();
            });
        });
      },
      done
    );
  });
}

// Retry the cache flushes a previous run recorded but did not confirm, before
// this run's equality checks skip those blogs for good.
function recoverPendingFlushes(stats, callback) {
  Promise.resolve(redis.hGetAll(PENDING_FLUSH_KEY))
    .then(function (pending) {
      pending = pending || {};
      var blogIDs = Object.keys(pending);

      Promise.resolve(redis.sMembers(PENDING_SITE_FLUSH_KEY))
        .then(function (siteBlogIDs) {
          siteBlogIDs = siteBlogIDs || [];

          if (!blogIDs.length && !siteBlogIDs.length) return callback();

          console.log(
            "Recovering",
            blogIDs.length + siteBlogIDs.length,
            "pending cache flush(es) from a previous run"
          );

          async.eachSeries(
            blogIDs,
            function (blogID, next) {
              var templateIDs;
              try {
                templateIDs = JSON.parse(pending[blogID]);
              } catch (e) {
                templateIDs = [];
              }

              if (!Array.isArray(templateIDs) || !templateIDs.length) {
                return Promise.resolve(redis.hDel(PENDING_FLUSH_KEY, blogID))
                  .then(function () {
                    next();
                  })
                  .catch(function () {
                    next();
                  });
              }

              finalizeBlog(blogID, templateIDs, function (err) {
                if (err)
                  recordError(stats, {
                    blogID: blogID,
                    error: "recover finalize: " + err.message,
                  });
                else stats.recovered++;
                next();
              });
            },
            function () {
              async.eachSeries(
                siteBlogIDs,
                function (blogID, next) {
                  Blog.get({ id: blogID }, function (err, blog) {
                    if (err || !blog) {
                      return Promise.resolve(
                        redis.sRem(PENDING_SITE_FLUSH_KEY, blogID)
                      )
                        .then(function () {
                          next();
                        })
                        .catch(function () {
                          next();
                        });
                    }

                    Blog.set(blogID, { cacheID: Date.now() }, function (err) {
                      if (err) {
                        recordError(stats, {
                          blogID: blogID,
                          error: "recover SITE flush: " + err.message,
                        });
                        return next();
                      }
                      console.log(
                        "Recovered cache flush for",
                        blog.handle || blogID
                      );
                      stats.recovered++;
                      Promise.resolve(redis.sRem(PENDING_SITE_FLUSH_KEY, blogID))
                        .then(function () {
                          next();
                        })
                        .catch(function () {
                          next();
                        });
                    });
                  });
                },
                callback
              );
            }
          );
        })
        .catch(callback);
    })
    .catch(callback);
}

function eachSiteView(iterator, done) {
  Promise.resolve(redis.sMembers(templateKey.blogTemplates("SITE")))
    .then(function (templateIDs) {
      var templateBar = progress.push("Template", (templateIDs || []).length);

      async.eachSeries(
        templateIDs || [],
        function (templateID, nextItem) {
          var nextTemplate = function () {
            templateBar.tick();
            nextItem();
          };

          Template.getAllViews(templateID, function (err, views) {
            if (err) {
              console.error(
                "Skipping SITE template; getAllViews failed",
                templateID,
                "-",
                err && err.message
              );
              return nextTemplate();
            }

            var viewBar = progress.push(
              "View",
              Object.keys(views || {}).length
            );

            async.eachOfSeries(
              views || {},
              function (view, name, nextView) {
                iterator(templateID, view, function () {
                  viewBar.tick();
                  nextView();
                });
              },
              function () {
                viewBar.pop();
                nextTemplate();
              }
            );
          });
        },
        function (err) {
          templateBar.pop();
          done(err);
        }
      );
    })
    .catch(done);
}

module.exports = main;
