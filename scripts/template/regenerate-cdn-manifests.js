// Regenerates the CDN manifest of every blog-owned template.
//
// Blog-owned template views now render with their literal links to files in
// the blog's folder wrapped in {{#cdn}} (models/template/util/resolveFolderLinks),
// and updateCdnManifest resolves those wrapped targets. Manifests computed
// before that have no entries for them, so until a template is next saved or
// synced its wrapped links miss the manifest and render as written (served
// by the origin). This fills them in.
//
// Safe to re-run, and to stop and resume: updateCdnManifest is idempotent and
// rewrites the whole manifest each time. SITE templates are skipped (they
// have no folder to resolve against). When a template's manifest changed,
// the blog's cacheID is bumped, so cached pages don't keep pointing at a
// stylesheet hash the regeneration replaced. A failing template is logged
// and skipped; the exit code is non-zero if any failed.
//
// Usage:
//   node scripts/template/regenerate-cdn-manifests.js [blog id, handle or domain]
//
// With no argument every blog is processed.

const { promisify } = require("util");
const eachTemplate = require("../each/template");
const Blog = require("models/blog");
const Template = require("models/template");
const updateCdnManifest = require("models/template/util/updateCdnManifest");

const getTemplateListAsync = promisify(Template.getTemplateList);
const getMetadataAsync = promisify(Template.getMetadata);
const updateCdnManifestAsync = promisify(updateCdnManifest);
const bumpCacheIDAsync = promisify(Blog.bumpCacheID);

const report = { templates: 0, changed: 0, errors: [] };

async function processTemplate(blog, template) {
  if (template.owner !== blog.id) return;

  report.templates++;

  const before = JSON.stringify((await getMetadataAsync(template.id)).cdn || {});

  await updateCdnManifestAsync(template.id);

  const after = JSON.stringify((await getMetadataAsync(template.id)).cdn || {});

  if (before === after) return;

  // Only the installed template has a manifest, so this is at most one
  // bump per blog in practice
  await bumpCacheIDAsync(blog.id);

  report.changed++;
  console.log(`${blog.id} ${template.id}: manifest changed`);
}

async function safelyProcessTemplate(blog, template) {
  try {
    await processTemplate(blog, template);
  } catch (err) {
    console.error(`Error regenerating manifest of ${template.id}:`, err);
    report.errors.push({ templateID: template.id, error: err.message });
  }
}

function logReport(callback) {
  console.log("\n=== Regenerate CDN manifests report ===");
  console.log(`Templates processed: ${report.templates}`);
  console.log(`Manifests changed: ${report.changed}`);
  console.log(`Errors: ${report.errors.length}`);

  report.errors.forEach((e) => console.log(`  ${e.templateID}: ${e.error}`));

  callback(
    report.errors.length
      ? new Error(`${report.errors.length} template(s) errored`)
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
      .then(() => logReport(callback))
      .catch(callback);

    return;
  }

  eachTemplate(
    function (user, blog, template, next) {
      safelyProcessTemplate(blog, template).then(() => next());
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
    console.log(blog ? `processing blog ${blog.id}` : "processing all blogs");

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
