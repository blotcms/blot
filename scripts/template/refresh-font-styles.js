// docker exec -it blot-container-green node scripts/template/refresh-font-styles.js [--apply]
//
// Re-renders the font locals (`font`, `*_font`) stored in the metadata of
// every blog-owned template from the current font registry
// (app/blog/static/fonts/index.json, woff2 + woff only).
//
// Templates output fonts with {{{font.styles}}}, and Mustache doesn't render
// the inserted value, so whatever string is stored in locals.font.styles is
// emitted verbatim into the template's CDN'd style.css. Templates created
// from the SITE package.json files before Mar 2025 stored a copy of the old
// registry CSS there, with an unrendered {{{config.cdn.origin}}} and
// .eot/.ttf/.otf sources that no longer exist. Only Template.setMetadata
// re-renders locals (models/template/injectLocals), so a template whose
// metadata hasn't been written since kept the stale string, and
// migrate-font-urls.js only rewrites views, never metadata.
//
// For each blog-owned template this runs injectLocals on a copy of the
// locals and, if the result differs, saves it with Template.setMetadata,
// which bumps the blog's cacheID and regenerates the CDN manifest so
// style.css gets a new hash. Locally edited templates are also written to
// the blog's folder. SITE templates are skipped: they rebuild from
// app/templates on startup.
//
// Idempotent: a second run changes nothing. Dry run by default; pass --apply
// to write. Afterwards run scripts/template/purge-unused-cdn-output.js to
// drop the superseded hashed outputs.
//
// Reports font locals whose id isn't in the registry (they stay stale) and
// any value still containing "config.cdn.origin" after the refresh.

const { promisify } = require("util");

const APPLY = process.argv.includes("--apply");

const report = {
  scanned: 0,
  changed: [],
  unknownFonts: [],
  unrendered: [],
  errors: [],
};

function isFontKey(key) {
  return key === "font" || key.includes("_font");
}

// Pure: takes a template's locals, returns { changed, locals, unknown,
// unrendered } without touching the input. `unknown` lists font locals with
// styles whose id the registry doesn't have; `unrendered` lists the paths of
// string values still containing config.cdn.origin after the refresh.
function refreshLocals(locals) {
  const injectLocals = require("models/template/injectLocals");
  const FONTS = require("blog/static/fonts");
  const copy = JSON.parse(JSON.stringify(locals || {}));

  injectLocals(copy);

  const unknown = [];
  Object.keys(copy).forEach((key) => {
    const value = copy[key];
    if (!isFontKey(key) || !value || typeof value !== "object") return;
    if (typeof value.styles !== "string") return;
    if (!FONTS.some((font) => font.id === value.id)) {
      unknown.push({ key, fontID: value.id });
    }
  });

  const unrendered = [];
  (function walk(value, path) {
    if (typeof value === "string") {
      if (value.includes("config.cdn.origin")) unrendered.push(path);
    } else if (value && typeof value === "object") {
      Object.keys(value).forEach((k) =>
        walk(value[k], path ? path + "." + k : k)
      );
    }
  })(copy, "");

  return {
    changed: JSON.stringify(copy) !== JSON.stringify(locals || {}),
    locals: copy,
    unknown,
    unrendered,
  };
}

async function processTemplate(blog, template) {
  const Template = require("models/template");
  const metadata = await promisify(Template.getMetadata)(template.id);
  report.scanned++;

  if (!metadata) return;

  const result = refreshLocals(metadata.locals);

  result.unknown.forEach((item) =>
    report.unknownFonts.push({ templateID: template.id, ...item })
  );
  result.unrendered.forEach((path) =>
    report.unrendered.push({ templateID: template.id, path })
  );

  if (!result.changed) return;

  console.log(
    `[${blog.id}] ${APPLY ? "Refreshing" : "Would refresh"} font styles of ${template.id}`
  );
  report.changed.push({ blogID: blog.id, templateID: template.id });

  if (!APPLY) return;

  await promisify(Template.setMetadata)(template.id, { locals: result.locals });

  if (metadata.localEditing) {
    try {
      await promisify(require("models/template/writeToFolder"))(
        blog.id,
        template.id
      );
    } catch (error) {
      // Match migrate-font-urls.js: log but don't fail the run.
      console.error(
        `Warning: Failed to write template ${template.id} to folder:`,
        error.message
      );
    }
  }
}

function logReport() {
  console.log(
    `\n=== Font Styles Refresh Report (${APPLY ? "applied" : "dry run"}) ===\n`
  );
  console.log(`Scanned: ${report.scanned} templates`);
  console.log(
    `${APPLY ? "Changed" : "Would change"}: ${report.changed.length} templates`
  );
  report.changed.forEach((item) =>
    console.log(`  - ${item.blogID} / ${item.templateID}`)
  );

  console.log(
    `\nFonts not in the registry (left stale): ${report.unknownFonts.length}`
  );
  report.unknownFonts.forEach((item) =>
    console.log(`  - ${item.templateID} / ${item.key} / ${item.fontID}`)
  );

  console.log(
    `\nValues still containing config.cdn.origin: ${report.unrendered.length}`
  );
  report.unrendered.forEach((item) =>
    console.log(`  - ${item.templateID} / ${item.path}`)
  );

  console.log(`\nErrors: ${report.errors.length}`);
  report.errors.forEach((item) =>
    console.log(`  - ${item.templateID}: ${item.error}`)
  );
  console.log("\n=== End Report ===\n");
}

function main(callback) {
  const eachTemplate = require("../each/template");

  eachTemplate(
    function (user, blog, template, next) {
      processTemplate(blog, template)
        .catch(function (error) {
          console.error(`Error processing template ${template.id}:`, error);
          report.errors.push({ templateID: template.id, error: error.message });
        })
        .then(() => next());
    },
    function (err) {
      if (err) return callback(err);
      logReport();
      callback(
        report.errors.length
          ? new Error(
              `${report.errors.length} template(s) errored - see report above`
            )
          : null
      );
    }
  );
}

if (require.main === module) {
  main(function (err) {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log("done");
    process.exit(0);
  });
}

module.exports = main;
module.exports.refreshLocals = refreshLocals;
