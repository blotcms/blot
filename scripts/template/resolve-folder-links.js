// Backfills `resolvedContent` on every view of every blog-owned template.
//
// Since setView started wrapping literal links to files in the blog's folder
// in {{#cdn}} (models/template/util/resolveFolderLinks), views saved before
// that have no resolved copy. Until they are saved again they keep rendering
// from their raw content, and the request-time pass in blog/render/
// replaceFolderLinks keeps rewriting their links. This re-saves each view
// that could contain a link through setView, which computes the resolved
// copy, then regenerates the template's CDN manifest once.
//
// Safe to re-run, and to stop and resume: setView short-circuits any view
// whose resolved copy is already up to date, and views that can't contain
// a link are skipped without a write. SITE templates are never touched (they
// render for many blogs and have no resolved copy). A failing view or
// template is logged and skipped; the exit code is non-zero if any failed.
//
// Usage:
//   node scripts/template/resolve-folder-links.js [blog id, handle or domain]
//
// With no argument every blog is processed.

const { promisify } = require("util");
const eachTemplate = require("../each/template");
const Template = require("models/template");
const resolveFolderLinks = require("models/template/util/resolveFolderLinks");
const updateCdnManifest = require("models/template/util/updateCdnManifest");

const getAllViewsAsync = promisify(Template.getAllViews);
const getTemplateListAsync = promisify(Template.getTemplateList);
const setViewAsync = promisify(Template.setView);
const updateCdnManifestAsync = promisify(updateCdnManifest);

const report = {
  templates: 0,
  views: 0,
  resaved: 0,
  skipped: 0,
  errors: [],
};

async function processTemplate(blog, template) {
  if (template.owner === "SITE" || template.owner !== blog.id) return;

  report.templates++;

  const views = await getAllViewsAsync(template.id);
  let resaved = 0;

  for (const name of Object.keys(views || {})) {
    const view = views[name];

    report.views++;

    if (!view || !resolveFolderLinks.mayContainFolderLinks(view.content)) {
      report.skipped++;
      continue;
    }

    try {
      // setView ignores the stored resolvedContent and recomputes it
      await setViewAsync(template.id, view);
      report.resaved++;
      resaved++;
    } catch (err) {
      console.error(`Error saving view ${name} of ${template.id}:`, err);
      report.errors.push({
        blogID: blog.id,
        templateID: template.id,
        viewName: name,
        error: err.message,
      });
    }
  }

  await updateCdnManifestAsync(template.id);

  if (resaved) {
    console.log(`${blog.id} ${template.id}: re-saved ${resaved} view(s)`);
  }
}

async function safelyProcessTemplate(blog, template) {
  try {
    await processTemplate(blog, template);
  } catch (err) {
    console.error(`Error processing template ${template.id}:`, err);
    report.errors.push({
      blogID: blog.id,
      templateID: template.id,
      viewName: null,
      error: err.message,
    });
  }
}

function logReport(callback) {
  console.log("\n=== Resolve folder links report ===");
  console.log(`Templates processed: ${report.templates}`);
  console.log(`Views seen: ${report.views}`);
  console.log(`Views re-saved: ${report.resaved}`);
  console.log(`Views skipped (no links): ${report.skipped}`);
  console.log(`Errors: ${report.errors.length}`);

  report.errors.forEach((e) =>
    console.log(`  ${e.templateID}${e.viewName ? " " + e.viewName : ""}: ${e.error}`)
  );

  // Surface a non-zero exit when anything errored so an incomplete run isn't
  // mistaken for a clean one.
  callback(
    report.errors.length
      ? new Error(`${report.errors.length} view(s)/template(s) errored`)
      : null
  );
}

function main(specificBlog, callback) {
  if (specificBlog) {
    getTemplateListAsync(specificBlog.id)
      .then(async function (templates) {
        for (const template of templates || []) {
          await safelyProcessTemplate(specificBlog, template);
        }
      })
      .then(function () {
        logReport(callback);
      })
      .catch(callback);

    return;
  }

  eachTemplate(
    function (user, blog, template, next) {
      safelyProcessTemplate(blog, template).then(function () {
        next();
      });
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
    run(null);
  } else {
    // An explicit identifier must resolve - never silently fall back to
    // every blog from a typo.
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
