const { promisify } = require("util");
const url = require("url");
const fetch = require("node-fetch");
const eachView = require("../each/view");
const Template = require("models/template");
const Blog = require("models/blog");
const generateCdnUrl = require("models/template/util/generateCdnUrl");
const writeToFolder = require("models/template/writeToFolder");
const getView = require("models/template/getView");
const config = require("../../config");

// Promisify callback-based functions
const setViewAsync = promisify(Template.setView);
const getMetadataAsync = promisify(Template.getMetadata);
const writeToFolderAsync = promisify(writeToFolder);
const getViewAsync = promisify(getView);

// Report structure
const report = {
  successes: [],
  mismatches: [],
  fetchErrors: [],
  revertErrors: [],
};

// Regex patterns to detect tokens (allow optional whitespace inside braces)
// Support both cssURL/css_url and scriptURL/script_url aliases
const CSS_URL_PATTERN = /\{\{\s*\{?\s*(?:cssURL|css_url)\s*\}\s*\}\}?/g;
const SCRIPT_URL_PATTERN =
  /\{\{\s*\{?\s*(?:scriptURL|script_url)\s*\}\s*\}\}?/g;

/**
 * Resolve a URL against a base URL
 * If the URL is already absolute, return it as-is
 * Otherwise, resolve it against the base URL
 */
function resolveUrl(baseUrl, targetUrl) {
  if (!targetUrl) return null;

  // If it's already a full URL (starts with http:// or https://), use it directly
  if (targetUrl.startsWith("http://") || targetUrl.startsWith("https://")) {
    return targetUrl;
  }

  // Protocol-relative URLs (starting with //) should be returned as-is
  if (targetUrl.startsWith("//")) {
    return targetUrl;
  }

  // Otherwise, resolve against base URL
  return url.resolve(baseUrl, targetUrl);
}

/**
 * Validate that a URL string is a valid URL format
 */
function isValidUrl(urlString) {
  if (!urlString || typeof urlString !== "string") return false;

  // Allow protocol-relative URLs (starting with //)
  if (urlString.startsWith("//")) {
    try {
      // Parse with a dummy protocol to properly extract hostname
      const parsed = url.parse("http:" + urlString);
      return !!parsed.hostname;
    } catch (e) {
      return false;
    }
  }

  // For absolute URLs, require both protocol and hostname
  try {
    const parsed = url.parse(urlString);
    return !!(parsed.protocol && parsed.hostname);
  } catch (e) {
    return false;
  }
}

/**
 * Fetch an asset from a URL and return the buffer
 */
async function fetchAsset(assetUrl) {
  const controller = new AbortController();
  const signal = controller.signal;
  const timer = setTimeout(() => controller.abort(), 10000); // 10 second timeout

  try {
    const response = await fetch(assetUrl, { signal });

    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Convert response to buffer
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    clearTimeout(timer);
    if (error.name === "AbortError") {
      throw new Error(
        `Failed to fetch ${assetUrl}: Request timed out after 10 seconds`,
        { cause: error }
      );
    }
    throw new Error(`Failed to fetch ${assetUrl}: ${error.message}`, {
      cause: error,
    });
  }
}

/**
 * Revert a view to its original content
 */
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

/**
 * Verify remote assets match CDN assets for installed templates
 * Returns true if verification passes, false otherwise
 */
async function verifyRemoteAssets(
  blog,
  template,
  view,
  workingView,
  originalContent,
  replacements
) {
  // Check if target views exist before fetching assets
  const replacementsToValidate = [];
  const replacementsToSkip = [];

  for (const replacement of replacements) {
    try {
      const targetView = await getViewAsync(template.id, replacement.viewName);
      if (!targetView) {
        // View doesn't exist - skip remote validation but proceed with replacement
        console.log(
          `View ${replacement.viewName} does not exist in template ${template.id}, skipping remote validation`
        );
        replacementsToSkip.push(replacement);
      } else {
        // View exists - include in validation
        replacementsToValidate.push(replacement);
      }
    } catch (error) {
      // If getView fails, assume view doesn't exist and skip validation
      if (error.message && error.message.includes("No view:")) {
        console.log(
          `View ${replacement.viewName} does not exist in template ${template.id}, skipping remote validation`
        );
        replacementsToSkip.push(replacement);
      } else {
        // Unexpected error - treat as validation failure
        throw error;
      }
    }
  }

  // Fetch original assets only for replacements that need validation
  const originalAssets = {};
  for (const replacement of replacementsToValidate) {
    try {
      console.log(
        `  [${blog.id}] Fetching original ${replacement.type} asset from ${replacement.originalUrl} for validation`
      );
      originalAssets[replacement.viewName] = await fetchAsset(
        replacement.originalUrl
      );
    } catch (error) {
      // If we can't fetch the original, we can't verify, so revert and skip
      await revertView(blog, template, view, originalContent);
      report.fetchErrors.push({
        blogID: blog.id,
        templateID: template.id,
        viewName: view.name,
        error: `Failed to fetch original ${replacement.type} asset: ${error.message}`,
        originalUrl: replacement.originalUrl,
      });
      return { success: false, replacementsToSkip: null };
    }
  }

  // Call setView to update the view and trigger CDN manifest update
  console.log(
    `  [${blog.id}] Updating view "${view.name}" in template "${template.id}" (will validate after update)`
  );
  await setViewAsync(template.id, workingView);

  // Get updated metadata to retrieve CDN manifest
  const metadata = await getMetadataAsync(template.id);
  if (!metadata || !metadata.cdn || Object.keys(metadata.cdn).length === 0) {
    await revertView(blog, template, view, originalContent);
    report.fetchErrors.push({
      blogID: blog.id,
      templateID: template.id,
      viewName: view.name,
      error: "Failed to retrieve CDN manifest after setView",
    });
    return { success: false, replacementsToSkip: null };
  }

  // Verify each replacement
  // First, check that all replacements (both validated and skipped) have hashes in metadata
  for (const replacement of replacements) {
    const hash = metadata.cdn[replacement.viewName];
    if (!hash) {
      await revertView(blog, template, view, originalContent);
      report.fetchErrors.push({
        blogID: blog.id,
        templateID: template.id,
        viewName: view.name,
        error: `CDN manifest missing hash for ${replacement.viewName}`,
      });
      return { success: false, replacementsToSkip: null };
    }
  }

  // Now verify only replacements that need validation (byte comparison)
  let allMatch = true;
  const cdnUrls = {};

  for (const replacement of replacementsToValidate) {
    const hash = metadata.cdn[replacement.viewName];
    // Generate CDN URL
    const cdnUrl = generateCdnUrl(replacement.viewName, hash);
    cdnUrls[replacement.viewName] = cdnUrl;

    try {
      // Fetch CDN asset
      console.log(
        `  [${blog.id}] Fetching CDN asset from ${cdnUrl} to verify it matches original`
      );
      const cdnAsset = await fetchAsset(cdnUrl);

      // Compare byte-for-byte
      const originalAsset = originalAssets[replacement.viewName];
      if (Buffer.compare(originalAsset, cdnAsset) !== 0) {
        allMatch = false;
        break;
      }
    } catch (error) {
      await revertView(blog, template, view, originalContent);
      report.fetchErrors.push({
        blogID: blog.id,
        templateID: template.id,
        viewName: view.name,
        error: `Failed to fetch CDN asset for ${replacement.viewName}: ${error.message}`,
        originalUrl: replacement.originalUrl,
        cdnUrl: cdnUrl,
      });
      return { success: false, replacementsToSkip: null };
    }
  }

  // For skipped replacements, just generate CDN URLs for reporting
  for (const replacement of replacementsToSkip) {
    const hash = metadata.cdn[replacement.viewName];
    const cdnUrl = generateCdnUrl(replacement.viewName, hash);
    cdnUrls[replacement.viewName] = cdnUrl;
  }

  // If assets don't match, revert
  if (!allMatch) {
    await revertView(blog, template, view, originalContent);
    report.mismatches.push({
      blogID: blog.id,
      templateID: template.id,
      viewName: view.name,
      originalUrls: replacements.map((r) => r.originalUrl),
      cdnUrls: Object.values(cdnUrls),
    });
    return { success: false, replacementsToSkip: null };
  }

  // Success! Assets match
  console.log(
    `  [${blog.id}] Validation successful for view "${view.name}" in template "${template.id}"`
  );
  return { success: true, replacementsToSkip };
}

/**
 * Process a single view to replace cssURL/scriptURL tokens with CDN helpers
 */
async function processView(user, blog, template, view) {
  // Skip SITE templates (default templates) - already migrated
  if (template.id.startsWith("SITE:") || template.owner === "SITE") {
    return;
  }

  if (!view || !view.content) {
    return; // Skip views without content
  }

  // Extend blog object to ensure url, cssURL, scriptURL are available
  const extendedBlog = Blog.extend(blog);

  // Determine the base URL based on whether the template is installed
  // If template.id === blog.template, the template is installed, use blogURL
  // Otherwise, use previewURL for the template
  let baseUrl;
  if (template.id === blog.template) {
    // Template is installed - use blog URL
    baseUrl = extendedBlog.url || extendedBlog.blogURL;
  } else {
    // Template is NOT installed - construct preview URL
    // Extract template slug from template ID (everything after first colon)
    const templateSlug = template.id.split(":").slice(1).join(":");
    const isMine = template.owner === blog.id;
    const myPrefix = isMine ? "my-" : "";
    baseUrl = `https://preview-of-${myPrefix}${templateSlug}-on-${blog.handle}.${config.host}`;
  }

  if (!baseUrl) {
    report.fetchErrors.push({
      blogID: blog.id,
      templateID: template.id,
      viewName: view.name,
      error: "No base URL available for blog",
    });
    return;
  }

  // Detect tokens in view content (reset regex lastIndex before using)
  CSS_URL_PATTERN.lastIndex = 0;
  SCRIPT_URL_PATTERN.lastIndex = 0;
  const hasCssUrl = CSS_URL_PATTERN.test(view.content);
  const hasScriptUrl = SCRIPT_URL_PATTERN.test(view.content);

  if (!hasCssUrl && !hasScriptUrl) {
    return; // No tokens to replace, skip this view
  }

  // Store original content for potential revert
  const originalContent = view.content;
  let modifiedContent = originalContent;
  const replacements = [];

  // Create a working copy of the view to prevent mutation
  const workingView = Object.assign({}, view);

  // Process cssURL tokens
  if (hasCssUrl && extendedBlog.cssURL && extendedBlog.cssURL.trim()) {
    const resolvedUrl = resolveUrl(baseUrl, extendedBlog.cssURL.trim());
    if (resolvedUrl && isValidUrl(resolvedUrl)) {
      // Reset regex before replace
      CSS_URL_PATTERN.lastIndex = 0;
      // Replace all occurrences
      modifiedContent = modifiedContent.replace(
        CSS_URL_PATTERN,
        "{{#cdn}}/style.css{{/cdn}}"
      );
      replacements.push({
        type: "css",
        originalUrl: resolvedUrl,
        viewName: "style.css",
      });
    }
  }

  // Process scriptURL tokens
  if (hasScriptUrl && extendedBlog.scriptURL && extendedBlog.scriptURL.trim()) {
    const resolvedUrl = resolveUrl(baseUrl, extendedBlog.scriptURL.trim());
    if (resolvedUrl && isValidUrl(resolvedUrl)) {
      // Reset regex before replace
      SCRIPT_URL_PATTERN.lastIndex = 0;
      // Replace all occurrences
      modifiedContent = modifiedContent.replace(
        SCRIPT_URL_PATTERN,
        "{{#cdn}}/script.js{{/cdn}}"
      );
      replacements.push({
        type: "script",
        originalUrl: resolvedUrl,
        viewName: "script.js",
      });
    }
  }

  // If no replacements were made, skip
  if (replacements.length === 0) {
    return;
  }

  // Update working view content
  workingView.content = modifiedContent;

  // Check if template is installed
  const isInstalled = template.id === blog.template;

  // Log what we're about to do
  console.log(
    `\n[${blog.id}] Processing view "${view.name}" in template "${template.id}" (${isInstalled ? "installed" : "not installed"})`
  );
  replacements.forEach((r) => {
    console.log(
      `  → Will replace ${r.type}URL: ${r.originalUrl} → {{#cdn}}/${r.viewName}{{/cdn}}`
    );
  });

  try {
    let verificationResult = null;
    let replacementReports = [];

    // For installed templates, perform remote verification
    if (isInstalled) {
      verificationResult = await verifyRemoteAssets(
        blog,
        template,
        view,
        workingView,
        originalContent,
        replacements
      );

      if (!verificationResult.success) {
        return; // Verification failed, view was already reverted
      }

      // Build replacements array with validation status
      replacementReports = replacements.map((r) => {
        const wasSkipped = verificationResult.replacementsToSkip.some(
          (skipped) => skipped.viewName === r.viewName
        );
        return {
          type: r.type,
          viewName: r.viewName,
          skippedValidation: wasSkipped,
        };
      });
    } else {
      // For non-installed templates, skip validation and just save
      console.log(
        `  [${blog.id}] Updating view "${view.name}" in template "${template.id}" (skipping validation)`
      );
      await setViewAsync(template.id, workingView);

      // Build replacements array
      replacementReports = replacements.map((r) => ({
        type: r.type,
        viewName: r.viewName,
        skippedValidation: true, // Non-installed templates skip validation
      }));
    }

    // Handle local editing (consolidated in one place)
    if (template.localEditing) {
      console.log(
        `  [${blog.id}] Writing locally-edited template "${template.id}" to folder`
      );
      try {
        await writeToFolderAsync(blog.id, template.id);
      } catch (error) {
        // Log error but don't fail the migration
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
      replacements: replacementReports,
    });
  } catch (error) {
    // Revert on any error
    await revertView(blog, template, view, originalContent);
    report.fetchErrors.push({
      blogID: blog.id,
      templateID: template.id,
      viewName: view.name,
      error: error.message,
    });
  }
}

/**
 * Log the migration report
 */
function logReport() {
  // Log report
  console.log("\n=== Migration Report ===\n");

  console.log(`Successfully migrated: ${report.successes.length} views`);
  if (report.successes.length > 0) {
    console.log("\nSuccesses:");
    report.successes.forEach((item) => {
      console.log(`  - ${item.blogID} / ${item.templateID} / ${item.viewName}`);
      item.replacements.forEach((r) => {
        const skipNote = r.skippedValidation
          ? " (validation skipped - view does not exist)"
          : "";
        console.log(
          `    → Replaced ${r.type}URL with {{#cdn}}/${r.viewName}{{/cdn}}${skipNote}`
        );
      });
    });
  }

  console.log(`\nMismatches: ${report.mismatches.length} views`);
  if (report.mismatches.length > 0) {
    console.log("\nMismatches (reverted):");
    report.mismatches.forEach((item) => {
      console.log(`  - ${item.blogID} / ${item.templateID} / ${item.viewName}`);
      console.log(`    Original URLs: ${item.originalUrls.join(", ")}`);
      console.log(`    CDN URLs: ${item.cdnUrls.join(", ")}`);
    });
  }

  console.log(`\nErrors: ${report.fetchErrors.length} views`);
  if (report.fetchErrors.length > 0) {
    console.log("\nErrors:");
    report.fetchErrors.forEach((item) => {
      console.log(`  - ${item.blogID} / ${item.templateID} / ${item.viewName}`);
      console.log(`    Error: ${item.error}`);
      if (item.originalUrl)
        console.log(`    Original URL: ${item.originalUrl}`);
      if (item.cdnUrl) console.log(`    CDN URL: ${item.cdnUrl}`);
    });
  }

  console.log(`\nRevert Errors: ${report.revertErrors.length} views`);
  if (report.revertErrors.length > 0) {
    console.log("\nRevert Errors (failed to revert changes):");
    report.revertErrors.forEach((item) => {
      console.log(`  - ${item.blogID} / ${item.templateID} / ${item.viewName}`);
      console.log(`    Error: ${item.error}`);
    });
  }

  console.log("\n=== End Report ===\n");
}
/**
 * Process all views for a specific blog
 * This short-circuits the iteration when a specific blog is passed
 */
async function processBlogViews(user, blog) {
  const getTemplateListAsync = promisify(Template.getTemplateList);
  const getAllViewsAsync = promisify(Template.getAllViews);

  const templates = await getTemplateListAsync(blog.id);

  // Process each template
  for (const template of templates) {
    // Skip SITE templates (default templates) - already migrated
    if (template.id.startsWith("SITE:") || template.owner === "SITE") continue;

    // Only process templates owned by the blog
    if (template.owner !== blog.id) continue;

    // Get all views for this template
    let views;

    try {
      views = await getAllViewsAsync(template.id);
    } catch (error) {
      console.error(`Error getting views for template ${template.id}:`, error);
      continue;
    }

    // Process each view
    for (const name of Object.keys(views || {})) {
      await processViewLoggingErrors(user, blog, template, views[name]);
    }
  }
}

// Log an error from one view and carry on with the rest
async function processViewLoggingErrors(user, blog, template, view) {
  try {
    await processView(user, blog, template, view);
  } catch (error) {
    console.error(
      `Error processing view ${view?.name} in template ${template?.id}:`,
      error
    );
    report.fetchErrors.push({
      blogID: blog?.id,
      templateID: template?.id,
      viewName: view?.name,
      error: error.message,
    });
  }
}

/**
 * Main function
 */
async function main(specificBlog) {
  if (specificBlog) {
    // Short-circuit: process only the specific blog
    const User = require("models/user");

    const user = await User.getById(specificBlog.owner);

    if (!user) throw new Error("No user found for blog owner");

    try {
      await processBlogViews(user, specificBlog);
    } catch (err) {
      console.error("Error during processing:", err);
      throw err;
    }
  } else {
    // Process all blogs using eachView
    await new Promise(function (resolve, reject) {
      eachView(
        function (user, blog, template, view, next) {
          processViewLoggingErrors(user, blog, template, view).then(
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
    }).catch(function (err) {
      console.error("Error during iteration:", err);
      throw err;
    });
  }

  logReport();
}

// Resolves to the blog for an identifier, or to undefined when the lookup
// fails: the default "null" then processes every blog
function getBlogIfAny(identifier) {
  var get = require("../get/blog");

  return new Promise(function (resolve) {
    get(identifier, function (err, user, blog) {
      resolve(blog);
    });
  });
}

// If run directly, execute main
if (require.main === module) {
  getBlogIfAny(process.argv[2] || "null").then(function (blog) {
    if (blog) {
      console.log("processing specific blog", blog.id);
    } else {
      console.log("processing all blogs");
    }

    return main(blog).then(
      function () {
        console.log("processed all blogs!");
        process.exit(0);
      },
      function (err) {
        console.error(err);
        process.exit(1);
      }
    );
  });
}

module.exports = main;
