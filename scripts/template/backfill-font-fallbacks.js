// Rebuilds the CDN manifest of every template whose font locals have a stack
// that now gets a fallback (blog/static/fonts/fallback), so existing sites
// serve a stylesheet with the Arabic and Japanese fallback.
//
// The stylesheet a page links, {{#cdn}}/style.css{{/cdn}}, is rendered once
// and stored under its hash when a template's manifest is built (on save, and
// for bundled templates when they change). The fallback is added at render
// time (blog/lib/models getMetadata), so templates saved before it keep the
// old stylesheet until their manifest is rebuilt. This does that.
//
// Safe to re-run: a manifest rebuild of an unchanged template changes
// nothing, and templates that need no change are skipped. To resume, run it
// again; templates already rebuilt report as unchanged. For a blog whose
// installed template changed, the blog's cacheID is bumped so pages relink.
//
// Dry run by default (lists the templates it would rebuild). Pass --apply to
// write. Usage: node scripts/template/backfill-font-fallbacks.js [--apply]

const eachTemplate = require("../each/template");
const bumpCacheID = require("models/blog/bumpCacheID");
const Template = require("models/template");
const updateCdnManifest = require("models/template/util/updateCdnManifest");
const { stackWithFallback } = require("blog/static/fonts/fallback");

const apply = process.argv.includes("--apply");
const totals = { seen: 0, needed: 0, changed: 0, failed: 0 };

function needsFallback(locals) {
  return Object.keys(locals || {}).some((key) => {
    if (key !== "font" && !key.includes("_font")) return false;
    const font = locals[key];
    return (
      font &&
      typeof font === "object" &&
      font.stack &&
      stackWithFallback(font) !== font.stack
    );
  });
}

async function processTemplate(template, blog) {
  totals.seen++;
  if (!needsFallback(template.locals)) return;
  totals.needed++;

  if (!apply) {
    console.log(`Would rebuild ${template.id}`);
    return;
  }

  try {
    const before = JSON.stringify(template.cdn || {});
    const after = JSON.stringify((await updateCdnManifest(template.id)) || {});

    if (before === after) return;

    totals.changed++;
    console.log(`Rebuilt ${template.id}`);

    if (blog && template.id === blog.template) {
      await bumpCacheID(blog.id);
    }
  } catch (err) {
    totals.failed++;
    console.error(`Error rebuilding ${template.id}:`, err);
  }
}

async function main() {
  console.log(apply ? "Applying" : "Dry run (pass --apply to write)");

  // Bundled templates, once
  const siteTemplates = (await Template.getTemplateList("SITE")).filter(
    (template) => template.owner === "SITE"
  );
  const seen = new Set();
  for (const template of siteTemplates) {
    if (seen.has(template.id)) continue;
    seen.add(template.id);
    await processTemplate(template, null);
  }

  await eachTemplate((user, blog, template) => processTemplate(template, blog));

  console.log(
    `Templates seen: ${totals.seen}, needing the fallback: ${totals.needed}, ` +
      `rebuilt with changes: ${totals.changed}, failed: ${totals.failed}`
  );
}

if (require.main === module) {
  main()
    .then(() => process.exit(totals.failed ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
