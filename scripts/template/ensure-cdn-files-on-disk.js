const { promisify } = require("util");
const path = require("path");
const fs = require("fs-extra");
const config = require("config");
const client = require("models/client");
const key = require("models/template/key");
const getMetadata = require("models/template/getMetadata");
const updateCdnManifest = require("models/template/util/updateCdnManifest");

const getMetadataAsync = promisify(getMetadata);
const updateCdnManifestAsync = promisify(updateCdnManifest);
const smembersAsync = function (redisKey) {
  return client.sMembers(redisKey);
};
const hdelAsync = function (redisKey, field) {
  return client.hDel(redisKey, field);
};

// Base directory for rendered output storage (same as in updateCdnManifest.js)
const RENDERED_OUTPUT_BASE_DIR = path.join(config.data_directory, "cdn", "template");

/**
 * Get the disk path for a rendered output file
 * (copied from updateCdnManifest.js)
 */
function getRenderedOutputPath(hash, viewName) {
  if (!hash || typeof hash !== "string" || hash.length < 4) {
    throw new Error("Invalid hash: must be a string with at least 4 characters");
  }
  if (!viewName || typeof viewName !== "string") {
    throw new Error("viewName must be a non-empty string");
  }
  const viewBaseName = path.basename(viewName);
  const dir1 = hash.substring(0, 2);
  const dir2 = hash.substring(2, 4);
  const hashRemainder = hash.substring(4);
  return path.join(RENDERED_OUTPUT_BASE_DIR, dir1, dir2, hashRemainder, viewBaseName);
}

/**
 * Check if a file exists on disk
 */
async function fileExistsOnDisk(hash, viewName) {
  try {
    const filePath = getRenderedOutputPath(hash, viewName);
    const exists = await fs.pathExists(filePath);
    return exists;
  } catch (err) {
    console.error(`Error checking file existence for ${viewName} (hash: ${hash}):`, err);
    return false;
  }
}

/**
 * Process a single SITE template
 */
async function processTemplate(templateID) {
  try {
    const metadata = await getMetadataAsync(templateID);
    
    if (!metadata) {
      console.log(`  ⚠️  Template ${templateID} not found, skipping...`);
      return { templateID, missingFiles: [], regenerated: false };
    }

    const cdnManifest = metadata.cdn || {};
    const manifestEntries = Object.keys(cdnManifest);
    
    if (manifestEntries.length === 0) {
      console.log(`  ✓  Template ${templateID} has no CDN files in manifest`);
      return { templateID, missingFiles: [], regenerated: false };
    }

    console.log(`  Checking ${manifestEntries.length} CDN file(s) for ${templateID}...`);
    
    const missingFiles = [];
    
    // Check each file in the manifest
    for (const viewName of manifestEntries) {
      const hash = cdnManifest[viewName];

      // Folder files ({ path, version }) are served from the blog's folder,
      // not stored by the manifest
      if (hash && typeof hash === "object") continue;
      
      if (!hash || typeof hash !== "string") {
        console.log(`    ⚠️  Invalid hash for ${viewName}, will regenerate`);
        missingFiles.push(viewName);
        continue;
      }

      const exists = await fileExistsOnDisk(hash, viewName);
      
      if (!exists) {
        console.log(`    ✗  Missing: ${viewName} (hash: ${hash})`);
        missingFiles.push(viewName);
      } else {
        console.log(`    ✓  Found: ${viewName}`);
      }
    }

    // If any files are missing, delete the CDN manifest first, then regenerate
    if (missingFiles.length > 0) {
      console.log(`  🔄  Deleting CDN manifest for ${templateID} to force regeneration...`);
      
      try {
        // Delete the 'cdn' field from the template metadata hash
        await hdelAsync(key.metadata(templateID), "cdn");
        console.log(`  ✓  Deleted CDN manifest for ${templateID}`);
      } catch (err) {
        console.error(`  ⚠️  Error deleting CDN manifest for ${templateID}:`, err);
        // Continue anyway - updateCdnManifest should still work
      }

      console.log(`  🔄  Regenerating CDN manifest for ${templateID} (${missingFiles.length} missing file(s))...`);
      
      try {
        await updateCdnManifestAsync(templateID);
        console.log(`  ✓  Successfully regenerated CDN manifest for ${templateID}`);
        return { templateID, missingFiles, regenerated: true };
      } catch (err) {
        console.error(`  ✗  Error regenerating CDN manifest for ${templateID}:`, err);
        return { templateID, missingFiles, regenerated: false, error: err };
      }
    } else {
      console.log(`  ✓  All CDN files present on disk for ${templateID}`);
      return { templateID, missingFiles: [], regenerated: false };
    }
  } catch (err) {
    console.error(`  ✗  Error processing template ${templateID}:`, err);
    return { templateID, missingFiles: [], regenerated: false, error: err };
  }
}

/**
 * Main function
 */
async function main() {
  console.log("Starting CDN file verification for SITE templates...\n");

  try {
    // Get all SITE templates
    const siteTemplateIDs = await smembersAsync(key.blogTemplates("SITE"));
    
    if (!siteTemplateIDs || siteTemplateIDs.length === 0) {
      console.log("No SITE templates found.");
      process.exit(0);
    }

    console.log(`Found ${siteTemplateIDs.length} SITE template(s)\n`);

    const results = [];
    
    // Process each template
    for (const templateID of siteTemplateIDs) {
      console.log(`Processing ${templateID}...`);
      const result = await processTemplate(templateID);
      results.push(result);
      console.log(); // Empty line for readability
    }

    // Print summary
    console.log("=".repeat(60));
    console.log("Summary:");
    console.log("=".repeat(60));
    
    const templatesWithMissingFiles = results.filter(r => r.missingFiles.length > 0);
    const templatesRegenerated = results.filter(r => r.regenerated);
    const templatesWithErrors = results.filter(r => r.error);

    console.log(`Total templates processed: ${results.length}`);
    console.log(`Templates with missing files: ${templatesWithMissingFiles.length}`);
    console.log(`Templates regenerated: ${templatesRegenerated.length}`);
    console.log(`Templates with errors: ${templatesWithErrors.length}`);

    if (templatesWithMissingFiles.length > 0) {
      console.log("\nTemplates with missing files:");
      templatesWithMissingFiles.forEach(r => {
        console.log(`  - ${r.templateID}: ${r.missingFiles.length} missing file(s)`);
        r.missingFiles.forEach(file => {
          console.log(`    • ${file}`);
        });
      });
    }

    if (templatesWithErrors.length > 0) {
      console.log("\nTemplates with errors:");
      templatesWithErrors.forEach(r => {
        console.log(`  - ${r.templateID}: ${r.error.message || r.error}`);
      });
    }

    console.log("\nDone!");
    process.exit(0);
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = main;
