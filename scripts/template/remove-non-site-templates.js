const config = require("config");
const Blog = require("models/blog");
const Template = require("models/template");
const eachTemplate = require("../each/template");

const DEFAULT_TEMPLATE_ID = "SITE:blog";

let removedCount = 0;
let updatedBlogsCount = 0;

function main() {
  // Only run in development environment
  if (config.environment !== "development") {
    console.error("This script can only be run in development environment");
    process.exit(1);
  }

  console.log("Starting removal of non-SITE templates...");

  // Use the each/template helper to iterate over all non-SITE templates
  // (the helper already filters to only templates owned by blogs, not SITE)
  eachTemplate(processTemplate, function (err) {
    if (err) {
      console.error("Fatal error:", err);
      process.exit(1);
    }

    console.log("\n=== Summary ===");
    console.log(`Templates removed: ${removedCount}`);
    console.log(`Blogs updated: ${updatedBlogsCount}`);
    console.log("Done!");
    process.exit(0);
  });
}

function processTemplate(user, blog, template, next) {
  if (template.owner === "SITE") {
    console.log(`Skipping template: ${template.id} (owner: ${template.owner})`);
    return next();
  }

  console.log(`Removing template: ${template.id} (owner: ${template.owner})`);

  // Check if this blog is using the template before dropping it
  if (blog.template === template.id) {
    Blog.set(blog.id, { template: DEFAULT_TEMPLATE_ID }, function (err) {
      if (err) {
        console.error(`  Error updating blog ${blog.id}:`, err);
        return next();
      }

      console.log(`  Updated blog ${blog.id} to use ${DEFAULT_TEMPLATE_ID}`);
      updatedBlogsCount++;
      dropTemplate();
    });
  } else {
    dropTemplate();
  }

  function dropTemplate() {
    // Extract template name from metadata slug or template ID
    // The template ID format is owner:slug, so we extract the slug part
    // Prefer template.slug if available, otherwise extract from template.id
    const templateName =
      template.slug || template.id.split(":").slice(1).join(":");

    Template.drop(template.owner, templateName, function (err) {
      if (err) {
        console.error(`Error dropping template ${template.id}:`, err);
        return next();
      }

      console.log(`  Removed template: ${template.id}`);
      removedCount++;
      next();
    });
  }
}

if (require.main === module) {
  main();
}

module.exports = main;
