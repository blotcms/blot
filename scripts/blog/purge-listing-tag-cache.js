// Identify blogs whose cached listing pages were rendered with empty tags
// (and empty backlinks / entry.tagged) before
// https://github.com/blotcms/blot/pull/1898
//
// listingViews.js aliases res.locals.entries onto the same Entry objects as
// posts / tagged.entries / search_results so older {{#entries}} templates keep
// working. Before the eachEntry identity-dedup landed, augment() ran twice on
// those objects and discarded the converted tags/backlinks. The live HTML is
// correct once that fix is deployed, but reverse-proxy cache may still hold
// the blank-tag pages.
//
// This script inspects the installed template's listing views (entries.html,
// tagged.html, search.html) plus the partials they include. A blog is
// affected if those views render entry tags, entry.tagged, or backlinks.
//
// Usage:
//   node scripts/blog/purge-listing-tag-cache.js
//       List affected blogs (dry run).
//   node scripts/blog/purge-listing-tag-cache.js --purge
//       List, confirm, bump cacheID and flush cache for affected blogs.
//   node scripts/blog/purge-listing-tag-cache.js --purge --yes
//       Same, skip the confirmation prompt.
//   node scripts/blog/purge-listing-tag-cache.js [blog] [--purge] [--yes]
//       Restrict to one blog (handle, domain, or ID).
//
// Run this after the PR #1898 fix is live. Purging beforehand would just
// recache the same empty tags.
//
// docker exec -it blot-node-app-1 node scripts/blog/purge-listing-tag-cache.js

const mustache = require("mustache");

const LISTING_VIEWS = ["entries.html", "tagged.html", "search.html"];

const LISTING_ENTRY_SECTIONS = {
  posts: true,
  entries: true,
  search_results: true,
  "tagged.entries": true,
};

const AUGMENTED_ROOTS = {
  tags: true,
  tagged: true,
  backlinks: true,
};

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = {
    purge: false,
    yes: false,
    help: false,
  };
  let identifier;

  args.forEach(function (arg) {
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      return;
    }
    if (arg === "--purge") {
      flags.purge = true;
      return;
    }
    if (arg === "--yes" || arg === "-y") {
      flags.yes = true;
      return;
    }
    if (arg.startsWith("-")) {
      throw new Error("Unknown flag: " + arg);
    }
    if (identifier) {
      throw new Error("Unexpected extra argument: " + arg);
    }
    identifier = arg;
  });

  return { flags, identifier };
}

function resolvePartial(partials, name) {
  if (!partials || !name) return "";

  if (partials[name] != null) return partials[name];

  if (!/\.(html|mustache)$/i.test(name) && partials[name + ".html"] != null) {
    return partials[name + ".html"];
  }

  const withoutExt = name.replace(/\.(html|mustache)$/i, "");
  if (partials[withoutExt] != null) return partials[withoutExt];

  return "";
}

function inListingEntry(stack) {
  return stack.some(function (name) {
    return LISTING_ENTRY_SECTIONS[name];
  });
}

function fieldFromName(name) {
  if (!name) return null;
  const root = String(name).split(".")[0];
  return AUGMENTED_ROOTS[root] ? root : null;
}

// Returns the augmented entry fields (tags, tagged, backlinks) that a listing
// view actually renders on listing Entry objects, including through partials
// included inside {{#posts}} / {{#entries}} / {{#search_results}}.
function inspectListingView(content, partials) {
  const fields = new Set();
  const seen = new Set();

  function walk(tokens, stack) {
    if (!Array.isArray(tokens)) return;

    const listing = inListingEntry(stack);

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const type = token[0];
      const name = token[1];

      if (type === "name" || type === "&" || type === "#" || type === "^") {
        if (listing) {
          const field = fieldFromName(name);
          if (field) fields.add(field);
        }
      }

      if (type === ">") {
        const key = name + "\0" + stack.join("\0");
        if (seen.has(key)) continue;
        seen.add(key);

        const body = resolvePartial(partials, name);
        if (!body) continue;

        let parsedPartial;
        try {
          parsedPartial = mustache.parse(body);
        } catch (e) {
          continue;
        }
        walk(parsedPartial, stack);
      }

      if ((type === "#" || type === "^") && Array.isArray(token[4])) {
        walk(token[4], stack.concat(name));
      }
    }
  }

  if (!content || typeof content !== "string") return [];

  let parsed;
  try {
    parsed = mustache.parse(content);
  } catch (e) {
    return [];
  }

  walk(parsed, []);
  return Array.from(fields).sort();
}

function inspectListingViews(views) {
  const hits = [];

  LISTING_VIEWS.forEach(function (viewName) {
    const view = views && views[viewName];
    if (!view || !view.content) return;

    const fields = inspectListingView(view.content, view.partials || {});
    fields.forEach(function (field) {
      hits.push({ view: viewName, field: field });
    });
  });

  return hits;
}

function blogURL(blog, host) {
  if (blog.domain) return "https://" + blog.domain;
  if (blog.handle && host) return "https://" + blog.handle + "." + host;
  return blog.id;
}

function summarizeHits(hits) {
  const byView = {};
  hits.forEach(function (hit) {
    if (!byView[hit.view]) byView[hit.view] = [];
    if (byView[hit.view].indexOf(hit.field) === -1) {
      byView[hit.view].push(hit.field);
    }
  });

  return Object.keys(byView)
    .sort()
    .map(function (view) {
      return view + ":" + byView[view].sort().join(",");
    })
    .join(" ");
}

function hitsNeedTags(hits) {
  return hits.some(function (hit) {
    return hit.field === "tags" || hit.field === "tagged";
  });
}

function hitsNeedBacklinks(hits) {
  return hits.some(function (hit) {
    return hit.field === "backlinks";
  });
}

const USAGE = `Identify blogs whose listing pages cached empty tags/backlinks
before https://github.com/blotcms/blot/pull/1898, and optionally flush them.

Usage:
  node scripts/blog/purge-listing-tag-cache.js [--purge] [--yes] [blog]

  (no flags)   List affected blogs. Does not flush.
  --purge      Bump cacheID and flush the reverse-proxy cache for those blogs.
  --yes, -y    Skip the confirmation prompt (only used with --purge).
  blog         Handle, domain, or ID. Omit to scan every blog.

Run this after the PR #1898 fix is deployed. Purging first recaches the bug.

  docker exec -it blot-node-app-1 node scripts/blog/purge-listing-tag-cache.js
  docker exec -it blot-node-app-1 node scripts/blog/purge-listing-tag-cache.js --purge
`;

async function main() {
  const { flags, identifier } = parseArgs(process.argv);

  if (flags.help) {
    console.log(USAGE);
    return { affected: [], skipped: [], errors: [] };
  }

  const { promisify } = require("util");
  const eachBlog = require("../each/blog");
  const getBlog = require("../get/blog");
  const Template = require("models/template");
  const Blog = require("models/blog");
  const client = require("models/client");
  const tagKey = require("models/tags/key");
  const config = require("config");
  const getConfirmation = require("../util/getConfirmation");
  const colors = require("colors/safe");

  const getFullViewAsync = promisify(Template.getFullView);
  const blogSetAsync = promisify(Blog.set);

  const templateCache = new Map();
  const affected = [];
  const skipped = [];
  const errors = [];
  let inspected = 0;

  async function loadListingViews(blogID, templateID) {
    const cached = templateCache.get(templateID);
    if (cached) return cached;

    const views = {};

    for (const viewName of LISTING_VIEWS) {
      try {
        const fullView = await getFullViewAsync(blogID, templateID, viewName);
        if (!fullView) continue;
        views[viewName] = {
          content: fullView[4],
          partials: fullView[1] || {},
        };
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        if (message.indexOf("No view:") === 0) continue;
        throw err;
      }
    }

    const hits = inspectListingViews(views);
    templateCache.set(templateID, hits);
    return hits;
  }

  async function blogHasTags(blogID) {
    const slugs = (await client.sMembers(tagKey.all(blogID))) || [];
    return slugs.length > 0;
  }

  async function inspectBlog(blog) {
    inspected += 1;

    if (!blog.template) {
      skipped.push({ blog: blog, reason: "no template" });
      return;
    }

    let hits;
    try {
      hits = await loadListingViews(blog.id, blog.template);
    } catch (err) {
      errors.push({
        blogID: blog.id,
        handle: blog.handle,
        error: err.message || String(err),
      });
      console.error(
        colors.red(
          "Failed to inspect " +
            blog.id +
            " (" +
            (blog.handle || "no handle") +
            "): " +
            (err.message || err)
        )
      );
      return;
    }

    if (!hits.length) return;

    const needsTags = hitsNeedTags(hits);
    const needsBacklinks = hitsNeedBacklinks(hits);

    let hasTags = false;
    if (needsTags) {
      try {
        hasTags = await blogHasTags(blog.id);
      } catch (err) {
        errors.push({
          blogID: blog.id,
          handle: blog.handle,
          error: "tags lookup: " + (err.message || err),
        });
        // Fail open: treat as tagged so we don't skip a blog we couldn't check.
        hasTags = true;
      }
    }

    if (needsTags && !hasTags && !needsBacklinks) {
      skipped.push({
        blog: blog,
        reason: "listing template renders tags, but blog has none",
        hits: hits,
      });
      return;
    }

    const record = {
      id: blog.id,
      handle: blog.handle,
      domain: blog.domain,
      template: blog.template,
      isDisabled: !!blog.isDisabled,
      url: blogURL(blog, config.host),
      hits: hits,
      hasTags: hasTags,
      needsBacklinks: needsBacklinks,
    };

    affected.push(record);
    console.log(
      colors.yellow(record.url) +
        "  " +
        record.id +
        "  " +
        record.template +
        "  " +
        summarizeHits(hits) +
        (record.isDisabled ? "  (disabled)" : "")
    );
  }

  function iterateBlogs() {
    if (identifier) {
      return new Promise(function (resolve, reject) {
        getBlog(identifier, function (err, _user, blog) {
          if (err || !blog) {
            return reject(err || new Error("No blog: " + identifier));
          }
          inspectBlog(blog).then(resolve).catch(reject);
        });
      });
    }

    return new Promise(function (resolve, reject) {
      eachBlog(
        function (_user, blog, next) {
          inspectBlog(blog)
            .then(function () {
              next();
            })
            .catch(function (err) {
              errors.push({
                blogID: blog && blog.id,
                handle: blog && blog.handle,
                error: err.message || String(err),
              });
              console.error(
                colors.red(
                  "Failed to process " +
                    (blog && blog.id) +
                    ": " +
                    (err.message || err)
                )
              );
              next();
            });
        },
        function (err) {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  }

  console.log(
    "Inspecting installed listing views for templates that render entry tags or backlinks."
  );
  console.log(
    "Those pages cached before PR #1898 still have empty tags/backlinks.\n"
  );

  await iterateBlogs();

  console.log("\n" + "=".repeat(60));
  console.log("Inspected: " + inspected + " blog" + (inspected === 1 ? "" : "s"));
  console.log(
    "Affected:  " + affected.length + " blog" + (affected.length === 1 ? "" : "s")
  );
  console.log(
    "Skipped:   " + skipped.length + " blog" + (skipped.length === 1 ? "" : "s")
  );
  console.log(
    "Errors:    " + errors.length + " blog" + (errors.length === 1 ? "" : "s")
  );

  if (affected.length) {
    const byTemplate = {};
    affected.forEach(function (record) {
      const key = record.template || "(none)";
      byTemplate[key] = (byTemplate[key] || 0) + 1;
    });
    console.log("\nBy template:");
    Object.keys(byTemplate)
      .sort(function (a, b) {
        return byTemplate[b] - byTemplate[a];
      })
      .forEach(function (templateID) {
        console.log("  " + byTemplate[templateID] + "  " + templateID);
      });
  }

  if (!flags.purge) {
    console.log(
      "\nDry run. Re-run with --purge to bump cacheID and flush the reverse-proxy cache."
    );
    return { affected, skipped, errors };
  }

  if (!affected.length) {
    console.log("\nNothing to purge.");
    return { affected, skipped, errors };
  }

  if (!identifier && !flags.yes) {
    const confirmed = await getConfirmation(
      "Flush cache for " +
        affected.length +
        " affected blog" +
        (affected.length === 1 ? "" : "s") +
        "?"
    );
    if (!confirmed) {
      console.log("Purge cancelled.");
      return { affected, skipped, errors, cancelled: true };
    }
  }

  let flushed = 0;
  let failed = 0;

  for (const record of affected) {
    try {
      await blogSetAsync(record.id, { cacheID: Date.now() });
      flushed += 1;
      console.log(
        colors.green("Flushed " + record.id + " (" + (record.handle || "no handle") + ")")
      );
    } catch (err) {
      failed += 1;
      errors.push({
        blogID: record.id,
        handle: record.handle,
        error: "flush: " + (err.message || err),
      });
      console.error(
        colors.red(
          "Failed to flush " +
            record.id +
            " (" +
            (record.handle || "no handle") +
            "): " +
            (err.message || err)
        )
      );
    }
  }

  console.log(
    "\nFlushed " + flushed + " blog" + (flushed === 1 ? "" : "s") + (failed ? ", " + failed + " failed" : "")
  );

  // models/blog/set kicks off proxy purges without waiting for them. Give
  // the rate-limited queue time to drain before the process exits.
  const waitMs = Math.min(5 * 60 * 1000, Math.max(10 * 1000, flushed * 500));
  console.log("Waiting " + Math.round(waitMs / 1000) + "s for proxy purges to finish...");
  await new Promise(function (resolve) {
    setTimeout(resolve, waitMs);
  });
  console.log("Done.");

  return { affected, skipped, errors, flushed, failed };
}

module.exports = {
  LISTING_VIEWS,
  inspectListingView,
  inspectListingViews,
  parseArgs,
  resolvePartial,
  summarizeHits,
  hitsNeedTags,
  hitsNeedBacklinks,
  blogURL,
};

if (require.main === module) {
  main()
    .then(function (result) {
      const failed = (result && result.failed) || 0;
      const inspectErrors = (result && result.errors) || [];
      process.exit(failed > 0 || inspectErrors.length > 0 ? 1 : 0);
    })
    .catch(function (err) {
      console.error(err);
      process.exit(1);
    });
}
