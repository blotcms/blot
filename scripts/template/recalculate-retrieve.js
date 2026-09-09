var eachView = require("../each/view");
var async = require("async");
var Template = require("models/template");
var templateKey = require("models/template/key");
var redis = require("models/client");
var Blog = require("models/blog");

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
      stats.skipped + ")"
    );

    process.exit(0);
  });
}

function main(callback) {
  var stats = {
    updated: 0,
    skipped: 0,
  };

  // Blog-owned template views.
  eachView(
    function (user, blog, template, view, next) {
      recalcView(template.id, view, stats, next);
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
            if (!err && changed) touchedSiteTemplates[templateID] = true;
            next(err);
          });
        },
        function (err) {
          if (err) return callback(err, stats);

          // setView bumped the cacheID of the synthetic "SITE" owner, not the
          // real blogs rendering these templates. Flush the full-view and
          // rendered-output caches of every blog whose active template we
          // just rewrote so the new retrieve metadata takes effect.
          invalidateBlogsUsing(Object.keys(touchedSiteTemplates), function (err) {
            callback(err, stats);
          });
        }
      );
    }
  );
}

function recalcView(templateID, view, stats, next) {
  if (!view || !view.name || !view.content) {
    stats.skipped++;
    return next(null, false);
  }

  // Force setView to re-parse template content and rewrite retrieve
  // metadata. setView short-circuits when content and retrieve are
  // unchanged, so pass a sentinel retrieve object. setView drops the
  // sentinel and rebuilds retrieve from the parser, preserving user
  // options such as includeDraft and filters.
  Template.setView(
    templateID,
    {
      name: view.name,
      content: view.content,
      retrieve: {
        __recalculateRetrieve: Date.now(),
      },
    },
    function (err) {
      if (err) return next(err);

      stats.updated++;
      console.log("Updated", templateID, view.name);
      next(null, true);
    }
  );
}

// setView bumps Blog.set(owner). For SITE:* templates the owner is the
// literal "SITE", so no real blog's cacheID changes and the full-view /
// rendered caches keep serving the old retrieve metadata. Mirror
// app/templates/index.js:emptyCacheForBlogsUsing - bump the cacheID of
// every blog whose active template is one we just rewrote.
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
