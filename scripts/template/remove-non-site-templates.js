const config = require("config");
const Blog = require("models/blog");
const Template = require("models/template");
const eachTemplate = require("../each/template");

const DEFAULT_TEMPLATE_ID = "SITE:blog";

let removedCount = 0;
let updatedBlogsCount = 0;

async function main() {
  // Only run in development environment
  if (config.environment !== "development") {
    console.error("This script can only be run in development environment");
    process.exit(1);
  }

  console.log("Starting removal of non-SITE templates...");

  // Use the each/template helper to iterate over all non-SITE templates
  // (the helper already filters to only templates owned by blogs, not SITE)
  try {
    await eachTemplateAsync(processTemplate);
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }

  console.log("\n=== Summary ===");
  console.log(`Templates removed: ${removedCount}`);
  console.log(`Blogs updated: ${updatedBlogsCount}`);
  console.log("Done!");
  process.exit(0);
}

// Runs doThis(user, blog, template) for each template, one at a time, and
// resolves once every template has been done. A rejection stops the run.
function eachTemplateAsync(doThis) {
  return new Promise(function (resolve, reject) {
    eachTemplate(
      function (user, blog, template, next) {
        doThis(user, blog, template).then(
          function () {
            next();
          },
          function (err) {
            next(err);
          }
        );
      },
      function (err) {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

async function processTemplate(user, blog, template) {
  if (template.owner === "SITE") {
    console.log(`Skipping template: ${template.id} (owner: ${template.owner})`);
    return;
  }

  console.log(`Removing template: ${template.id} (owner: ${template.owner})`);

  // Check if this blog is using the template before dropping it
  if (blog.template === template.id) {
    try {
      await Blog.set(blog.id, { template: DEFAULT_TEMPLATE_ID });
    } catch (err) {
      console.error(`  Error updating blog ${blog.id}:`, err);
      return;
    }

    console.log(`  Updated blog ${blog.id} to use ${DEFAULT_TEMPLATE_ID}`);
    updatedBlogsCount++;
  }

  await dropTemplate(template);
}

async function dropTemplate(template) {
  // Extract template name from metadata slug or template ID
  // The template ID format is owner:slug, so we extract the slug part
  // Prefer template.slug if available, otherwise extract from template.id
  const templateName =
    template.slug || template.id.split(":").slice(1).join(":");

  try {
    await Template.drop(template.owner, templateName);
  } catch (err) {
    console.error(`Error dropping template ${template.id}:`, err);
    return;
  }

  console.log(`  Removed template: ${template.id}`);
  removedCount++;
}

if (require.main === module) {
  main().catch(function (err) {
    console.error(err);
    process.exit(1);
  });
}

module.exports = main;
