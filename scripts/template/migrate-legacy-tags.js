// Rewrites customer template views off two legacy template features, so the
// engine can stop supporting them:
//
// - the camelCase retrieve aliases ({{allEntries}}, {{#encodeJSON}}, ...)
//   become their snake_case names
// - {{cssURL}} / {{css_url}} / {{blog.cssURL}} and the scriptURL forms become
//   the URL they produced, /style.css?cache={{blog.cacheID}}&amp;extension=.css
//   (and the script.js equivalent), so nothing a blog serves changes
//
// It also deletes the cssURL and scriptURL fields stored on each blog, which
// the engine no longer sets or reads. Old code writes them again whenever a
// blog's cacheID changes, so run it with --apply once more after deploying.
//
// Only Mustache tags are touched, never text, comments or partial names. An
// alias a template or view defines as its own local is left alone, and tags
// after a set-delimiter tag are read with the new delimiters. Content and stored
// partials are both rewritten. For a locally edited template, the rewritten
// views' files (and only those) are written back to the blog's folder.
//
// Dry run by default. --apply writes; --verbose lists each view.
// Usage: node scripts/template/migrate-legacy-tags.js [--apply] [--verbose]
//   [--limit N] [--concurrency N]

const { promisify } = require("util");
const client = require("models/client");
const Template = require("models/template");
const Blog = require("models/blog");
const clients = require("clients");
const folder = require("storage/folder");
const folderLock = require("sync/lock");
const determineTemplateFolder = require("models/template/determineTemplateFolder");
const joinpath = require("path").join;
const redisKeys = require("../util/redisKeys");

const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");
const option = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
// --limit N saves at most N views, to time a batch
const LIMIT = option("--limit", 0);
const CONCURRENCY = option("--concurrency", 4);
const setView = promisify(Template.setView);
const getBlog = promisify((id, callback) => Blog.get({ id }, callback));
const templateFolder = promisify(determineTemplateFolder);

const ALIASES = {
  absoluteURLs: "absolute_urls",
  allEntries: "all_entries",
  allTags: "all_tags",
  appCSS: "app_css",
  appJS: "app_js",
  encodeJSON: "encode_json",
  encodeURIComponent: "encode_uri_component",
  encodeXML: "encode_xml",
  isActive: "is_active",
  latestEntry: "latest_entry",
  plugin_css: "app_css",
  plugin_js: "app_js",
  recentEntries: "recent_entries",
};

const ASSET_URLS = {
  cssURL: "css",
  css_url: "css",
  "blog.cssURL": "css",
  scriptURL: "js",
  script_url: "js",
  "blog.scriptURL": "js",
};

// models/blog/url, with the cache ID read at render time
function assetURL(kind, open, close) {
  const view = kind === "css" ? "/style.css" : "/script.js";
  return view + "?cache=" + open + "blog.cacheID" + close + "&amp;extension=." + kind;
}

// Returns { text, changes }. Follows set-delimiter tags ({{=<% %>=}}), so
// tags written with custom delimiters are rewritten in those delimiters.
// ownLocals: names the template or view defines itself, never renamed.
function rewrite(text, ownLocals) {
  const changes = [];
  const stack = [];
  let open = "{{";
  let close = "}}";
  let pos = 0;
  let out = "";

  while (pos < text.length) {
    const start = text.indexOf(open, pos);
    if (start === -1) break;

    const triple = text[start + open.length] === "{";
    const innerStart = start + open.length + (triple ? 1 : 0);
    const end = text.indexOf((triple ? "}" : "") + close, innerStart);
    if (end === -1) break;
    const tagEnd = end + (triple ? 1 : 0) + close.length;
    const inner = text.slice(innerStart, end);
    const whole = text.slice(start, tagEnd);

    out += text.slice(pos, start);
    pos = tagEnd;

    const set = !triple && /^=\s*(\S+)\s+(\S+)\s*=$/.exec(inner);
    if (set) {
      open = set[1];
      close = set[2];
      out += whole;
      continue;
    }

    out += rewriteTag(whole, inner, triple, (n) =>
      triple ? open + "{" + n + "}" + close : open + n + close
    );
  }

  return { text: out + text.slice(pos), changes };

  function rewriteTag(whole, inner, triple, wrap) {
    let sigil = "";

    if (!triple) {
      sigil = /^\s*([#^/&>!<$]?)/.exec(inner)[1];
      if (sigil === "!" || sigil === ">" || sigil === "<" || sigil === "$") return whole;
    }

    const m = /^(\s*[#^/&]?\s*)([^\s]+?)(\s*)$/.exec(inner);
    if (!m) return whole;
    const [, prefix, name, suffix] = m;

    if (sigil === "/") {
      const top = stack.pop();
      if (top && top.renamed && top.name === name) return wrap(prefix + top.renamed + suffix);
    }

    const segments = name.split(".");
    const first = segments[0];
    let renamed = null;
    let result = whole;

    if (ALIASES[first] && !ownLocals.has(first)) {
      renamed = [ALIASES[first], ...segments.slice(1)].join(".");
      changes.push(first + " -> " + ALIASES[first]);
    } else if (ASSET_URLS[name] && (sigil === "" || sigil === "&" || triple)) {
      changes.push(name + " -> url");
      result = assetURL(ASSET_URLS[name], open, close);
    } else if (ASSET_URLS[name] && sigil !== "/") {
      changes.push("unhandled section " + name);
    }

    if (renamed) result = wrap(prefix + renamed + suffix);
    if (sigil === "#" || sigil === "^") stack.push({ name, renamed });
    return result;
  }
}

function parseJSON(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    return {};
  }
}

const counts = {};
function count(name) {
  counts[name] = (counts[name] || 0) + 1;
}

async function blogAssetFields() {
  await redisKeys("blog:*:info", async (key) => {
    if (key.split(":").length !== 3) return;
    if ((await client.type(key)) !== "hash") return;
    const [css, js] = await client.hmGet(key, ["cssURL", "scriptURL"]);
    if (css === null && js === null) return;
    count("blogs with cssURL/scriptURL fields");
    if (APPLY) await client.hDel(key, ["cssURL", "scriptURL"]);
  });
}

// The updates a view needs, read fresh, or null if it needs none
async function viewUpdates(id, name, template) {
  const key = "template:" + id + ":view:" + name;
  if ((await client.type(key)) !== "hash") return null;

  const [content, partialsJSON, localsJSON] = await client.hmGet(key, [
    "content",
    "partials",
    "locals",
  ]);
  if (typeof content !== "string") return null;

  const ownLocals = new Set([...template.locals, ...Object.keys(parseJSON(localsJSON))]);
  const updates = { name };
  const changes = [];

  const main = rewrite(content, ownLocals);
  if (main.text !== content) updates.content = main.text;
  changes.push(...main.changes);

  const partials = parseJSON(partialsJSON);
  let partialsChanged = false;
  for (const partial in partials) {
    if (typeof partials[partial] !== "string") continue;
    const result = rewrite(partials[partial], ownLocals);
    if (result.text === partials[partial]) continue;
    partials[partial] = result.text;
    changes.push(...result.changes);
    partialsChanged = true;
  }

  if (!updates.content && !partialsChanged) return null;

  // setView drops file-backed partial markers that aren't in the content
  // or in updates.partials, so always pass the whole map back
  updates.partials = partials;
  return { updates, changes };
}

// Every changed view bumps its blog's cacheID and rebuilds the template's CDN
// manifest, so a blog's views are saved one at a time, a few blogs at once.
async function applyBlog(owner, views, templates, progress) {
  const byTemplate = new Map();
  for (const { id, name } of views) {
    if (!byTemplate.has(id)) byTemplate.set(id, []);
    byTemplate.get(id).push(name);
  }

  for (const [id, names] of byTemplate) {
    if (LIMIT && progress.done >= LIMIT) break;
    const template = templates.get(id);

    // A locally edited template is saved and its changed files written under
    // the blog's folder lock, so a sync can't rebuild it from the old files
    // in between. Only the rewritten views' files are written.
    if (!template.localEditing) {
      await saveViews(id, names, template, progress);
      continue;
    }

    let release;
    try {
      // As models/template/withFolderLock: waits about 30s for a sync
      ({ release } = await folderLock.lock(owner, {
        ttl: 10 * 1000,
        heartbeat: 3 * 1000,
        retries: 6,
        minTimeout: 500,
      }));
    } catch (err) {
      process.exitCode = 1;
      count("templates skipped: folder busy");
      console.log("Could not lock folder for", owner, id, err.message);
      continue;
    }

    try {
      const saved = await saveViews(id, names, template, progress);
      if (saved.length) await writeViews(owner, id, template, saved);
    } finally {
      await release().catch((err) => console.log("Failed to release lock", owner, err.message));
    }
  }
}

// Writes the named views' files to a locally edited template's folder, as
// models/template/writeToFolder does but leaving every other file (and
// package.json) alone, and skipping a file whose content already matches.
// The caller holds the blog's folder lock.
async function writeViews(owner, id, template, names) {
  count("templates written to folder");
  try {
    const blog = await getBlog(owner);
    const syncClient = blog && blog.client && clients[blog.client];
    const dir = joinpath(await templateFolder(owner), template.slug);

    for (const name of names) {
      const content = await client.hGet("template:" + id + ":view:" + name, "content");
      if (typeof content !== "string" || !content) continue;
      const path = joinpath(dir, name);

      const existing = await folder.read(owner, path).catch(() => null);
      if (existing && existing.toString("utf-8") === content) continue;

      if (syncClient) await promisify(syncClient.write)(owner, path, content);
      await folder.write(owner, path, content);
      count("view files written");
    }
  } catch (err) {
    // Redis is already migrated, so a re-run won't find these views: write
    // them by hand, or with models/template/writeToFolder (the whole template)
    process.exitCode = 1;
    console.log("Failed to write views to folder", owner, id, names.join(","), err.message);
  }
}

// Saves the views that still need rewriting; resolves to their names
async function saveViews(id, names, template, progress) {
  const saved = [];

  for (const name of names) {
    if (LIMIT && progress.done >= LIMIT) break;
    const result = await viewUpdates(id, name, template);
    if (!result) continue;
    try {
      await setView(id, result.updates);
      saved.push(name);
      count("views saved");
    } catch (err) {
      process.exitCode = 1;
      count("views failed");
      console.log("Failed to save view", id, name, err.message);
    }
    if (++progress.done % 500 === 0) {
      const minutes = (Date.now() - progress.start) / 60000;
      console.log(`${progress.done} of ${progress.total} views saved in ${minutes.toFixed(1)} min`);
    }
  }

  return saved;
}

async function main() {
  await blogAssetFields();

  const templates = new Map();

  await redisKeys("template:*:info", async (key) => {
    if ((await client.type(key)) !== "hash") return;
    const id = key.slice("template:".length, -":info".length);
    const [owner, localEditing, locals, slug] = await client.hmGet(key, [
      "owner",
      "localEditing",
      "locals",
      "slug",
    ]);
    if (!owner || owner === "SITE") return;
    templates.set(id, {
      owner,
      slug,
      localEditing: localEditing === "true",
      locals: Object.keys(parseJSON(locals)),
    });
  });

  // Owner -> views to rewrite. Only names are kept; content is re-read when
  // each view is saved.
  const byOwner = new Map();
  let total = 0;

  await redisKeys("template:*:view:*", async (key) => {
    const rest = key.slice("template:".length);
    const i = rest.indexOf(":view:");
    const id = rest.slice(0, i);
    const name = rest.slice(i + ":view:".length);
    const template = templates.get(id);
    if (!template) return;

    const result = await viewUpdates(id, name, template);
    if (!result) return;

    total++;
    count("views to rewrite");
    result.changes.forEach(count);
    if (VERBOSE) console.log("would rewrite:", id, name, [...new Set(result.changes)].join(", "));
    if (!byOwner.has(template.owner)) byOwner.set(template.owner, []);
    byOwner.get(template.owner).push({ id, name });
  });

  counts["blogs with views to rewrite"] = byOwner.size;

  if (APPLY) {
    const progress = { done: 0, total: LIMIT || total, start: Date.now() };
    const queue = [...byOwner];
    const worker = async () => {
      while (queue.length && !(LIMIT && progress.done >= LIMIT)) {
        const [owner, views] = queue.shift();
        await applyBlog(owner, views, templates, progress);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const minutes = (Date.now() - progress.start) / 60000;
    console.log(`${progress.done} views saved in ${minutes.toFixed(1)} min`);
  }

  console.log(APPLY ? "Applied:" : "Dry run, nothing written:");
  for (const [name, n] of Object.entries(counts).sort()) console.log(" ", name, n);
  if (!Object.keys(counts).length) console.log("  nothing to do");
}

if (require.main === module) {
  main()
    .then(() => process.exit())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { rewrite };
