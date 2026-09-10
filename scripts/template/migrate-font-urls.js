// Rewrites hand-authored web-font URLs in template view content from the
// dropped .eot/.ttf/.otf/.svg formats to .woff2, following the migration of
// app/blog/static/fonts to a .woff2 + .woff only library.
//
// SITE-owned templates are skipped: they re-render their font @font-face
// rules from app/blog/static/fonts/index.json via
// models/template/injectLocals and are already correct once the regenerated
// fonts are deployed. Only customer templates that pasted raw /fonts/<dir>/
// URLs (or whole @font-face blocks) into their own CSS/template views need
// rewriting - those files 404 after the old formats are removed.
//
// Structurally modelled on scripts/template/replaceCssAndScriptUrls.js:
// iterate via scripts/each/view.js (or a single blog), rewrite content,
// Template.setView, writeToFolder when the template is locally edited,
// revert the view on error, and print a success/skip/error report.
//
// Usage:
//   node scripts/template/migrate-font-urls.js            # every blog
//   node scripts/template/migrate-font-urls.js <blog>     # one blog (id/handle/url)

const { promisify } = require("util");

// Heavy deps (redis-backed) are required lazily inside the functions that
// use them so this module can be required for `rewriteContent` alone - the
// pure string transform - without spinning up a redis connection.

// Report structure (mirrors replaceCssAndScriptUrls.js)
const report = {
  successes: [], // views whose content we rewrote
  handAuthored: [], // views that referenced /fonts/ or @font-face (for eyeballing)
  skipped: [], // SITE templates / views with nothing to change
  errors: [], // views that threw (reverted)
  revertErrors: [], // views we failed to revert
};

const DROPPED_EXTENSIONS = ["eot", "ttf", "otf", "svg"];

// A /fonts/<dir>/<file>.<dropped-ext> URL, with optional ?query and optional
// #fragment (e.g. #iefix). Capture groups: 1=path without ext, 2=ext,
// 3=?query (may be empty), 4=#fragment (dropped).
const FONT_URL_PATTERN = new RegExp(
  "(/fonts/[a-z0-9._-]+/[a-z0-9._-]+)\\.(" +
    DROPPED_EXTENSIONS.join("|") +
    ")((?:\\?[^\\s'\")#]*)?)(#[^\\s'\")]*)?",
  "gi"
);

// A url(...) whose target we just rewrote, immediately followed by a
// format('embedded-opentype' | 'truetype' | 'opentype' | 'svg'). Once the
// URL points at a .woff2 file the format keyword must say woff2 too.
const FORMAT_AFTER_WOFF2_PATTERN =
  /(url\(\s*['"]?[^)'"]*\.woff2(?:\?[^)'"]*)?['"]?\s*\)\s*format\(\s*['"]?)(embedded-opentype|truetype|opentype|svg)(['"]?\s*\))/gi;

// Used only to flag views for human review - any reference to the font
// library or a raw @font-face block in customer content.
const HAND_AUTHORED_HINT = /@font-face|\/fonts\/[a-z0-9._-]+\//i;

function rewriteContent(content) {
  let changed = false;

  let next = content.replace(
    FONT_URL_PATTERN,
    (match, path, ext, query, fragment) => {
      changed = true;
      // Rewrite ?...&extension=.<ext>... -> .woff2, drop #iefix / any fragment.
      const newQuery = (query || "").replace(
        /([?&]extension=)\.?(?:eot|ttf|otf|svg)/gi,
        "$1.woff2"
      );
      return `${path}.woff2${newQuery}`;
    }
  );

  next = next.replace(FORMAT_AFTER_WOFF2_PATTERN, (match, before, kw, after) => {
    changed = true;
    return `${before}woff2${after}`;
  });

  return { content: next, changed };
}

function setViewAsync(id, view) {
  const Template = require("models/template");
  return promisify(Template.setView)(id, view);
}

function writeToFolderAsync(blogID, templateID) {
  const writeToFolder = require("models/template/writeToFolder");
  return promisify(writeToFolder)(blogID, templateID);
}

async function revertView(blog, template, view, originalContent) {
  console.log(
    `  [${blog.id}] Reverting view "${view.name}" in template "${template.id}"`
  );
  try {
    await setViewAsync(template.id, {
      name: view.name,
      content: originalContent,
    });
  } catch (revertError) {
    report.revertErrors.push({
      blogID: blog.id,
      templateID: template.id,
      viewName: view.name,
      error: `Failed to revert view: ${revertError.message}`,
    });
    console.error(
      `Warning: Failed to revert view ${view.name} in database:`,
      revertError.message
    );
  }
}

async function processView(user, blog, template, view) {
  // SITE templates re-render fonts from index.json - nothing to migrate.
  if (template.id.startsWith("SITE:") || template.owner === "SITE") {
    report.skipped.push({
      blogID: blog.id,
      templateID: template.id,
      viewName: view && view.name,
      reason: "SITE template",
    });
    return;
  }

  if (!view || !view.content) return;

  const originalContent = view.content;
  const { content: modifiedContent, changed } = rewriteContent(originalContent);

  // Flag for human review regardless of whether we changed anything: a
  // customer template with hand-authored @font-face / /fonts/ references
  // may still need a manual look (e.g. it points at a family we renamed, or
  // uses a weight the library no longer ships).
  if (HAND_AUTHORED_HINT.test(modifiedContent)) {
    const matches = (modifiedContent.match(/\/fonts\/[a-z0-9._-]+\/[^\s'")]+/gi) || [])
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 20);
    report.handAuthored.push({
      blogID: blog.id,
      templateID: template.id,
      viewName: view.name,
      installed: template.id === blog.template,
      urls: matches,
    });
  }

  if (!changed) {
    return; // idempotent: nothing to rewrite in this view
  }

  console.log(
    `\n[${blog.id}] Rewriting font URLs in view "${view.name}" of template "${template.id}"`
  );

  try {
    await setViewAsync(template.id, {
      name: view.name,
      content: modifiedContent,
    });

    if (template.localEditing) {
      console.log(
        `  [${blog.id}] Writing locally-edited template "${template.id}" to folder`
      );
      try {
        await writeToFolderAsync(blog.id, template.id);
      } catch (error) {
        // Match the precedent: log but don't fail the migration.
        console.error(
          `Warning: Failed to write template ${template.id} to folder:`,
          error.message
        );
      }
    }

    report.successes.push({
      blogID: blog.id,
      templateID: template.id,
      viewName: view.name,
    });
  } catch (error) {
    await revertView(blog, template, view, originalContent);
    report.errors.push({
      blogID: blog.id,
      templateID: template.id,
      viewName: view.name,
      error: error.message,
    });
  }
}

function logReport(callback) {
  console.log("\n=== Font URL Migration Report ===\n");

  console.log(`Rewritten: ${report.successes.length} views`);
  report.successes.forEach((item) => {
    console.log(`  - ${item.blogID} / ${item.templateID} / ${item.viewName}`);
  });

  console.log(
    `\nHand-authored font references (review these): ${report.handAuthored.length} views`
  );
  report.handAuthored.forEach((item) => {
    console.log(
      `  - ${item.blogID} / ${item.templateID} / ${item.viewName}` +
        (item.installed ? " (installed)" : "")
    );
    item.urls.forEach((u) => console.log(`      ${u}`));
  });

  console.log(`\nErrors: ${report.errors.length} views`);
  report.errors.forEach((item) => {
    console.log(`  - ${item.blogID} / ${item.templateID} / ${item.viewName}`);
    console.log(`    Error: ${item.error}`);
  });

  console.log(`\nRevert Errors: ${report.revertErrors.length} views`);
  report.revertErrors.forEach((item) => {
    console.log(`  - ${item.blogID} / ${item.templateID} / ${item.viewName}`);
    console.log(`    Error: ${item.error}`);
  });

  console.log(
    `\nSkipped (SITE templates): ${report.skipped.length} views entries`
  );

  console.log("\n=== End Report ===\n");

  // Surface a non-zero exit when anything errored so an incomplete run
  // isn't mistaken for a clean one.
  callback(
    report.errors.length > 0
      ? new Error(
          `${report.errors.length} view(s)/template(s) errored - see report above`
        )
      : null
  );
}

function processBlogViews(user, blog, callback) {
  const async = require("async");
  const Template = require("models/template");
  const getTemplateListAsync = promisify(Template.getTemplateList);
  const getAllViewsAsync = promisify(Template.getAllViews);

  getTemplateListAsync(blog.id)
    .then(function (templates) {
      async.eachSeries(
        templates || [],
        function (template, nextTemplate) {
          if (template.id.startsWith("SITE:") || template.owner === "SITE") {
            return nextTemplate();
          }
          if (template.owner !== blog.id) return nextTemplate();

          getAllViewsAsync(template.id)
            .then(function (views) {
              async.eachOfSeries(
                views,
                function (view, name, nextView) {
                  processView(user, blog, template, view)
                    .then(() => nextView())
                    .catch(function (error) {
                      console.error(
                        `Error processing view ${view && view.name} in template ${template.id}:`,
                        error
                      );
                      report.errors.push({
                        blogID: blog.id,
                        templateID: template.id,
                        viewName: view && view.name,
                        error: error.message,
                      });
                      nextView();
                    });
                },
                nextTemplate
              );
            })
            .catch(function (error) {
              console.error(
                `Error getting views for template ${template.id}:`,
                error
              );
              // Record it - a swallowed load failure would otherwise make an
              // incomplete run look clean (this template was never inspected).
              report.errors.push({
                blogID: blog.id,
                templateID: template.id,
                viewName: null,
                error: `Failed to load views: ${error.message}`,
              });
              nextTemplate();
            });
        },
        callback
      );
    })
    .catch(callback);
}

function main(specificBlog, callback) {
  if (specificBlog) {
    const User = require("models/user");
    const getByIdAsync = promisify(User.getById);

    getByIdAsync(specificBlog.owner, function (err, user) {
      if (err || !user) {
        return callback(err || new Error("No user found for blog owner"));
      }
      processBlogViews(user, specificBlog, function (err) {
        if (err) {
          console.error("Error during processing:", err);
          return callback(err);
        }
        logReport(callback);
      });
    });
  } else {
    const eachView = require("../each/view");
    eachView(
      async function (user, blog, template, view, next) {
        try {
          await processView(user, blog, template, view);
          next();
        } catch (error) {
          console.error(
            `Error processing view ${view && view.name} in template ${template && template.id}:`,
            error
          );
          report.errors.push({
            blogID: blog && blog.id,
            templateID: template && template.id,
            viewName: view && view.name,
            error: error.message,
          });
          next();
        }
      },
      function (err) {
        if (err) {
          console.error("Error during iteration:", err);
          return callback(err);
        }
        logReport(callback);
      }
    );
  }
}

if (require.main === module) {
  const get = require("../get/blog");
  const arg = process.argv[2];

  const run = (blog) => {
    console.log(
      blog ? `processing specific blog ${blog.id}` : "processing all blogs"
    );
    main(blog, function (err) {
      if (err) {
        console.error(err);
        process.exit(1);
      }
      console.log("done");
      process.exit(0);
    });
  };

  if (!arg) {
    // No argument -> every blog.
    run(null);
  } else {
    // An explicit identifier was given: it must resolve. Never silently
    // fall back to all-blogs (that would rewrite templates installation-wide
    // from a typo).
    get(arg, function (err, user, blog) {
      if (err || !blog) {
        console.error(
          `No blog found for "${arg}" - aborting rather than falling back to all blogs.`
        );
        process.exit(1);
      }
      run(blog);
    });
  }
}

module.exports = main;
module.exports.rewriteContent = rewriteContent;
