// Refreshes the stored font styles of every customer template that uses a
// font, so existing sites serve a stylesheet with the corrected hanging
// punctuation rules.
//
// injectLocals writes each font local's rendered `styles` into the template's
// metadata whenever the metadata is saved, and the stylesheet a page links,
// {{#cdn}}/style.css{{/cdn}}, is rendered from those stored locals and kept
// under its hash. So templates saved before the quote widths in
// blog/static/fonts/build and the dropping of the other fonts' rules in
// models/template/injectLocals changed keep the old rules until they are
// saved again. This saves each one's locals again (which re-injects the
// styles and rebuilds its CDN manifest) and bumps the cacheID of the blog it
// is installed on. Bundled templates need nothing: app/templates compares
// them with the registry at startup and rebuilds the ones that differ.
//
// Templates a person edits as files in their blog folder (localEditing) are
// skipped, as are templates with no font local. Safe to re-run: saving
// unchanged locals changes nothing the second time. To resume, run it again.
// The cacheID of each blog whose installed template uses a font is bumped on
// every run, changed or not, so pages relink even after an interrupted run.
//
// Dry run by default (lists the templates it would save). Pass --apply to
// write. Usage: node scripts/template/backfill-hanging-punctuation.js [--apply]

const eachTemplate = require("../each/template");
const bumpCacheID = require("models/blog/bumpCacheID");
const Template = require("models/template");
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
    console.log(`Would save ${template.id}`);
    return;
  }

  try {
    const metadata = await Template.getMetadata(template.id);
    // Snapshot first: setMetadata injects the styles into the locals object
    // it is given
    const before = JSON.stringify([metadata.locals, metadata.cdn || {}]);
    await Template.setMetadata(template.id, { locals: metadata.locals });
    const after = await Template.getMetadata(template.id);

    if (before !== JSON.stringify([after.locals, after.cdn || {}])) {
      totals.changed++;
      console.log(`Saved ${template.id}`);
    }

    // Bump even when this run found nothing to change: a run interrupted
    // between the save and the bump (or a failed bump) leaves cached pages
    // linking the old stylesheet, which the rebuild removed. A spare bump
    // costs one re-render of the site's pages.
    if (blog && template.id === blog.template) {
      await bumpCacheID(blog.id);
    }
  } catch (err) {
    totals.failed++;
    console.error(`Error saving ${template.id}:`, err);
  }
}

async function main() {
  console.log(apply ? "Applying" : "Dry run (pass --apply to write)");

  await eachTemplate((user, blog, template) => processTemplate(template, blog));

  console.log(
    `Templates seen: ${totals.seen}, skipped as locally edited: ${totals.edited}, ` +
      `using a font: ${totals.needed}, saved with changes: ${totals.changed}, ` +
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
