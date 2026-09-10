var eachBlog = require("../each/blog");
var async = require("async");
var Template = require("models/template");
var templateKey = require("models/template/key");
var redis = require("models/client");
var Blog = require("models/blog");
var updateCdnManifest = require("models/template/util/updateCdnManifest");

if (require.main === module) {
  main(function (err, stats) {
    if (err) {
      console.error(err);
      process.exit(1);
    }

    console.log(
      "Done. Recalculated retrieve metadata for",
      stats.updated,
      "views",
      "(skipped",
      stats.skipped,
      "invalid,",
      stats.alreadyMigrated,
      "already migrated)"
    );

    process.exit(0);
  });
}

// Projected-entry retrieve locals. parseTemplate records references to a heavy
// entry field under `retrieve.<local>.fields.<field>`; the old parser stored
// these locals as a bare `true`. A stored view whose retrieve already carries
// that `fields` projection metadata was therefore written by the new parser,
// and setView persists retrieve atomically, so recalculating it would be a
// no-op. Skipping those views makes an interrupted run cheap to resume.
var PROJECTED_ENTRY_LOCALS = [
  "allEntries",
  "all_entries",
  "recentEntries",
  "recent_entries",
  "latestEntry",
  "latest_entry",
  "posts",
  "search_results",
  "tagged",
  "archives",
];

function hasProjectionMetadata(retrieve) {
  if (!retrieve || typeof retrieve !== "object") return false;

  return PROJECTED_ENTRY_LOCALS.some(function (local) {
    var value = retrieve[local];
    return (
      !!value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !!value.fields &&
      typeof value.fields === "object"
    );
  });
}

function main(callback) {
  var stats = {
    updated: 0,
    skipped: 0,
    alreadyMigrated: 0,
  };

  // Blog-owned templates. Recalculate every view of every template with the
  // per-view cache work deferred (see recalcView), then, once per blog whose
  // templates changed, bump that blog's cacheID a single time and rebuild the
  // CDN manifest of each changed template.
  //
  // setView would otherwise bump the owner blog's cacheID and rebuild the CDN
  // manifest once per changed view, for every template the blog owns - needless
  // repetition of a fleet-wide cache flush.
  eachBlog(
    function (user, blog, nextBlog) {
      recalcBlog(blog.id, stats, nextBlog);
    },
    function (err) {
      if (err) return callback(err, stats);

      // Bundled SITE:* templates are used directly by blogs but are skipped
      // by scripts/each - iterate them explicitly so their views also pick
      // up field projection metadata.
      var touchedSiteTemplates = {};

      eachSiteView(
        function (templateID, view, next) {
          recalcView(templateID, view, stats, function (err, changed) {
            if (changed) touchedSiteTemplates[templateID] = true;
            next(err);
          });
        },
        function (err) {
          // setView's cacheID bump is deferred for these, and their owner is
          // the synthetic "SITE" anyway. Flush the full-view / rendered-output
          // caches of every blog whose active template we just rewrote so the
          // new retrieve metadata takes effect - even if iteration stopped on
          // an error, so a partial run still flushes what it did rewrite.
          invalidateBlogsUsing(
            Object.keys(touchedSiteTemplates),
            function (flushErr) {
              callback(err || flushErr, stats);
            }
          );
        }
      );
    }
  );
}

function recalcBlog(blogID, stats, done) {
  Template.getTemplateList(blogID, function (err, templates) {
    if (err) return done(err);

    var owned = (templates || []).filter(function (template) {
      return template.owner === blogID;
    });

    var changedTemplateIDs = [];

    async.eachSeries(
      owned,
      function (template, nextTemplate) {
        recalcTemplateViews(template.id, stats, function (err, changed) {
          if (changed) changedTemplateIDs.push(template.id);
          // Stop the blog loop on a genuine setView error, but keep the
          // partial `changed` set so finalizeBlog still flushes the views
          // that were rewritten before the failure.
          nextTemplate(err);
        });
      },
      function (err) {
        finalizeBlog(blogID, changedTemplateIDs, function (flushErr) {
          done(err || flushErr);
        });
      }
    );
  });
}

function recalcTemplateViews(templateID, stats, done) {
  Template.getAllViews(templateID, function (err, views) {
    if (err) return done(err, false);

    var changed = false;
    var firstErr = null;

    async.eachOfSeries(
      views || {},
      function (view, name, nextView) {
        recalcView(templateID, view, stats, function (err, viewChanged) {
          if (viewChanged) changed = true;
          if (err && !firstErr) firstErr = err;
          nextView(err);
        });
      },
      function (err) {
        done(firstErr || err || null, changed);
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
function finalizeBlog(blogID, changedTemplateIDs, done) {
  if (!changedTemplateIDs.length) return done();

  // Re-read the blog: this script is long-running and the owner may have
  // switched active template while we worked through their other templates.
  Blog.get({ id: blogID }, function (err, blog) {
    if (err) return done(err);
    if (!blog) return done();

    Blog.set(blogID, { cacheID: Date.now() }, function (err) {
      if (err) return done(err);

      console.log("Flushed cache for", blog.handle || blogID);

      // Rebuild the CDN manifest once per changed template. updateCdnManifest
      // no-ops for templates that aren't installed on their owner blog, so an
      // inactive template costs only a metadata lookup here.
      async.eachSeries(
        changedTemplateIDs,
        function (templateID, next) {
          updateCdnManifest(templateID, next);
        },
        done
      );
    });
  });
}

function recalcView(templateID, view, stats, next) {
  if (!view || !view.name || !view.content) {
    stats.skipped++;
    return next(null, false);
  }

  // Idempotency: a view whose stored retrieve already carries field-projection
  // metadata was rewritten by the new parser on an earlier run. Skip it so an
  // interrupted run can be restarted without redoing completed work.
  if (hasProjectionMetadata(view.retrieve)) {
    stats.alreadyMigrated++;
    return next(null, false);
  }

  // Force setView to re-parse template content and rewrite retrieve
  // metadata. setView short-circuits when content and retrieve are
  // unchanged, so pass a sentinel retrieve object. setView drops the
  // sentinel and rebuilds retrieve from the parser, preserving user
  // options such as includeDraft and filters.
  //
  // deferCacheBump: skip setView's per-view cacheID bump and CDN manifest
  // rebuild - the caller does that once per blog / template instead.
  Template.setView(
    templateID,
    {
      name: view.name,
      content: view.content,
      retrieve: {
        __recalculateRetrieve: Date.now(),
      },
    },
    { deferCacheBump: true },
    function (err) {
      if (err) {
        // setView commits the view hash (multi.exec) before the steps that
        // can still fail here - the deferred error-entry cleanup, or in
        // non-deferred callers the cache bump / manifest rebuild. So an
        // error does not mean the retrieve metadata was left untouched.
        // Report the view as changed anyway so the caller still flushes
        // this template's caches before the error stops the run.
        return next(err, true);
      }

      stats.updated++;
      console.log("Updated", templateID, view.name);
      next(null, true);
    }
  );
}

// Mirror app/templates/index.js:emptyCacheForBlogsUsing - bump the cacheID of
// every blog whose active template is one we just rewrote. Used for SITE:*
// templates, whose owner is the literal "SITE" so no real blog's cacheID is
// touched by the recalculation itself.
function invalidateBlogsUsing(templateIDs, done) {
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
          if (err) return next(err);
          if (!blog || !blog.template || !touched[blog.template]) return next();

          Blog.set(blogID, { cacheID: Date.now() }, function (err) {
            if (err) return next(err);
            console.log("Flushed cache for", blog.handle || blogID);
            next();
          });
        });
      },
      done
    );
  });
}

function eachSiteView(iterator, done) {
  redis
    .sMembers(templateKey.blogTemplates("SITE"))
    .then(function (templateIDs) {
      async.eachSeries(
        templateIDs || [],
        function (templateID, nextTemplate) {
          Template.getAllViews(templateID, function (err, views) {
            if (err) return nextTemplate(err);

            async.eachOfSeries(
              views || {},
              function (view, name, nextView) {
                iterator(templateID, view, nextView);
              },
              nextTemplate
            );
          });
        },
        done
      );
    })
    .catch(done);
}

module.exports = main;
