// Rebuilds the CDN manifest of every template that uses a font, so existing
// sites serve a stylesheet with the corrected hanging punctuation rules.
//
// The stylesheet a page links, {{#cdn}}/style.css{{/cdn}}, is rendered once
// and stored under its hash when a template's manifest is built (on save, and
// for bundled templates when they change). The quote widths in a font's
// styles (blog/static/fonts/build) and the dropping of the other fonts' rules
// (models/template/injectLocals) are applied at that render, so templates
// built earlier keep the old stylesheet until their manifest is rebuilt. This
// does that.
//
// Templates a person edits as files in their blog folder (localEditing) are
// skipped, as are templates with no font local. Safe to re-run: a manifest
// rebuild of an unchanged template changes nothing. To resume, run it again;
// templates already rebuilt report as unchanged. The cacheID of each blog
// whose installed template uses a font is bumped on every run, changed or
// not, so pages relink even after an interrupted run.
//
// Dry run by default (lists the templates it would rebuild). Pass --apply to
// write. Usage: node scripts/template/backfill-hanging-punctuation.js [--apply]

const eachTemplate = require("../each/template");
const bumpCacheID = require("models/blog/bumpCacheID");
const Template = require("models/template");
const updateCdnManifest = require("models/template/util/updateCdnManifest");
const FONTS = require("blog/static/fonts");

const apply = process.argv.includes("--apply");
const totals = { seen: 0, edited: 0, needed: 0, changed: 0, failed: 0 };

function usesFont(locals) {
  return Object.keys(locals || {}).some((key) => {
    if (key !== "font" && !key.includes("_font")) return false;
    const font = locals[key];
    return (
      font &&
      typeof font === "object" &&
      FONTS.some((candidate) => candidate.id === font.id)
    );
  });
}

async function processTemplate(template, blog) {
  totals.seen++;

  if (template.localEditing) {
    totals.edited++;
    return;
  }

  if (!usesFont(template.locals)) return;
  totals.needed++;

  if (!apply) {
    console.log(`Would rebuild ${template.id}`);
    return;
  }

  try {
    const before = JSON.stringify(template.cdn || {});
    const after = JSON.stringify((await updateCdnManifest(template.id)) || {});

    if (before !== after) {
      totals.changed++;
      console.log(`Rebuilt ${template.id}`);
    }

    // Bump even when this run found the manifest unchanged: a run interrupted
    // between the rebuild and the bump (or a failed bump) leaves cached pages
    // linking the old stylesheet, which the rebuild removed. A spare bump
    // costs one re-render of the site's pages.
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
    `Templates seen: ${totals.seen}, skipped as locally edited: ${totals.edited}, ` +
      `using a font: ${totals.needed}, rebuilt with changes: ${totals.changed}, ` +
      `failed: ${totals.failed}`
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
