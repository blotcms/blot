// Moves every customer view that uses {{#folder}} to {{#folder_legacy}}, the
// same retriever under a second name (app/blog/render/retrieve/index.js), so
// nothing breaks when {{#folder}} is replaced by its new design (#2693).
//
// A tag is rewritten when its top-level key is `folder`: {{folder}},
// {{{folder}}}, {{& folder}}, {{#folder}}...{{/folder}}, {{^folder}} and dotted
// forms such as {{#folder.contents}}. Keys that merely contain the word
// ({{folder_name}}, {{#entry.folder}}, {{#folders}}) and text outside tags are
// left alone. The rewrite works from Mustache's own tokens (with their
// positions in the source), so whitespace inside tags and custom delimiters
// are handled; see rewriteFolderTags.
//
// What it covers, for every template a blog owns (bundled SITE templates are
// only checked, never changed):
//
//  - each view's content, and the inline partials a view declares (strings in
//    the view's `partials`, from package.json). Partials that are views of the
//    template are views like any other. A view retrieves what its own content
//    names; the partials it includes are folded in at render time
//    (getFullView), so rewriting every view that names `folder` is enough.
//  - views are found by their stored `retrieve` list (parseTemplate's output),
//    a fresh parse of their content, and the tags themselves.
//  - a template edited from the blog's folder (metadata.localEditing) is
//    rebuilt from the folder on every sync, so a change in Redis alone would
//    be overwritten. For those, the changed view files (and package.json when
//    an inline partial changed) are also rewritten in the folder through
//    clients/folder, the one way Blot changes a folder, while holding the
//    folder lock. The view is then saved in Redis with the same content, so
//    no rebuild is needed: the sync the write triggers reads files identical
//    to what Redis holds and changes nothing.
//
// Views are saved through the template model (setView), so retrievers, cache
// IDs and CDN manifests are recomputed. setView keeps any retrieve local the
// stored view had, so a stored `folder` would survive a plain update; a view
// is therefore dropped and saved again with all its other fields (url,
// locals, partials, retrieve options). If saving fails, the old view is put
// back. After each save the view is read back and must retrieve no `folder`.
//
// Dry run by default: prints, per template, its ID, whether it is installed
// and locally edited, each view or partial that changes and the changed tags.
// Pass --apply to write; it then re-scans everything and exits non-zero if any
// view or partial still names `folder`. Safe to re-run: a second run finds
// nothing to change.
//
// Run it after {{#folder_legacy}} is deployed. In a unit:
//
//   docker exec -u 1000 blot-blue node scripts/template/migrate-folder-legacy.js
//   docker exec -u 1000 blot-blue node scripts/template/migrate-folder-legacy.js --apply
//
// Optionally pass blog handles, blog IDs or template IDs to limit the run:
//
//   node scripts/template/migrate-folder-legacy.js --apply <handle> <template ID>

const Mustache = require("mustache");
const { posix } = require("path");

const FROM = "folder";
const TO = "folder_legacy";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whether a tag key has `folder` as its top-level name
function namesFolder(key) {
  return (
    typeof key === "string" && (key === FROM || key.startsWith(FROM + "."))
  );
}

// Rewrites the Mustache tags of `source` whose top-level key is `folder` to
// name `folder_legacy`. Resolves with { content, changes, unresolved }:
// changes lists each tag as { line, before, after, inside } (inside: the
// sections the tag sits in), unresolved the tags it could not place.
function rewriteFolderTags(source) {
  const tokens = Mustache.parse(source);
  const edits = [];
  const changes = [];
  const unresolved = [];
  // The delimiters in force, which a {{=<% %>=}} token changes for the tokens
  // after it (they come in document order, closing tags included).
  let tags = Mustache.tags.slice();

  function lineAt(index) {
    return source.slice(0, index).split("\n").length;
  }

  function record(at, before, after, inside) {
    edits.push({ at, length: FROM.length });
    changes.push({ line: lineAt(at), before, after, inside });
  }

  function rewriteOpening(token, inside) {
    const [, key, start, end] = token;
    const text = source.slice(start, end);
    const prefix = new RegExp("^" + escapeRegExp(tags[0]) + "\\s*[#^&{]?\\s*");
    const match = prefix.exec(text);

    if (!match || !text.startsWith(key, match[0].length)) {
      unresolved.push({ line: lineAt(start), before: text });
      return;
    }

    const cut = match[0].length;
    record(
      start + cut,
      text,
      text.slice(0, cut) + TO + text.slice(cut + FROM.length),
      inside
    );
  }

  function rewriteClosing(token, inside) {
    const key = token[1];
    const start = token[5];
    const closing = new RegExp(
      "^" +
        escapeRegExp(tags[0]) +
        "(\\s*\\/\\s*)" +
        escapeRegExp(key) +
        "\\s*" +
        escapeRegExp(tags[1])
    );
    const match = closing.exec(source.slice(start));

    if (!match) {
      unresolved.push({ line: lineAt(start), before: "{{/" + key + "}}" });
      return;
    }

    const cut = tags[0].length + match[1].length;
    record(
      start + cut,
      match[0],
      match[0].slice(0, cut) + TO + match[0].slice(cut + FROM.length),
      inside
    );
  }

  function walk(list, inside) {
    for (const token of list) {
      const type = token[0];

      if (type === "=") {
        tags = token[1].split(/\s+/, 2);
        continue;
      }

      if (!["name", "&", "#", "^"].includes(type)) continue;

      const targeted = namesFolder(token[1]);
      if (targeted) rewriteOpening(token, inside);

      if (type === "#" || type === "^") {
        walk(token[4], inside.concat(token[1]));
        if (targeted) rewriteClosing(token, inside);
      }
    }
  }

  walk(tokens, []);

  let content = source;
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    content =
      content.slice(0, edit.at) + TO + content.slice(edit.at + edit.length);
  }

  changes.sort((a, b) => a.line - b.line);

  return { content, changes, unresolved };
}

// Rewrites the inline partials of a view's `partials` (strings, or objects
// with a `content` string and their own `partials`). Resolves with
// { partials, changes } where partials is a copy and each change names its
// partial.
function rewritePartials(partials) {
  const changes = [];

  function copy(map, prefix) {
    const result = {};

    for (const name of Object.keys(map || {})) {
      const value = map[name];
      const label = prefix + name;

      if (typeof value === "string") {
        const rewritten = rewriteFolderTags(value);
        rewritten.changes.forEach((change) =>
          changes.push(Object.assign({ partial: label }, change))
        );
        result[name] = rewritten.content;
      } else if (value && typeof value === "object") {
        const inner = Object.assign({}, value);

        if (typeof value.content === "string") {
          const rewritten = rewriteFolderTags(value.content);
          rewritten.changes.forEach((change) =>
            changes.push(Object.assign({ partial: label }, change))
          );
          inner.content = rewritten.content;
        }

        if (value.partials && typeof value.partials === "object")
          inner.partials = copy(value.partials, label + " > ");

        result[name] = inner;
      } else {
        result[name] = value;
      }
    }

    return result;
  }

  return { partials: copy(partials, ""), changes };
}

// The Template model and friends are required where used, so the rewriter
// above can be tested without a database.
function models() {
  return {
    Template: require("models/template"),
    parseTemplate: require("models/template/parseTemplate"),
    withFolderLock: require("models/template/withFolderLock"),
    makeID: require("models/template/util/makeID"),
    folder: require("storage/folder"),
    blogFolder: require("clients/folder"),
  };
}

function retrievesFolder(retrieve) {
  return !!retrieve && retrieve[FROM] !== undefined;
}

// Works out what a template needs without changing anything. Resolves with
// { views, files, packageFile, problems }:
//  views: [{ view, content, partials, changes, staleRetrieve }], the views to
//    save (content and partials are the rewritten ones)
//  files: [{ path, content, changes }], locally edited template files to write
//  packageFile: { path, content, changes } or null, the package.json to write
//  problems: strings, things it could not read or place
async function planTemplate(blog, template) {
  const { Template, parseTemplate } = models();
  const plan = { views: [], files: [], packageFile: null, problems: [] };

  let views;

  try {
    ({ views } = await Template.getAllViews(template.id));
  } catch (err) {
    plan.problems.push("cannot read the template's views: " + err.message);
    return plan;
  }

  for (const name of Object.keys(views || {}).sort()) {
    const view = views[name];
    let content;
    let parts;

    try {
      content = rewriteFolderTags(view.content || "");
    } catch (err) {
      plan.problems.push(name + ": cannot parse: " + err.message);
      continue;
    }

    try {
      parts = rewritePartials(view.partials);
    } catch (err) {
      plan.problems.push(
        name + ": cannot parse an inline partial: " + err.message
      );
      continue;
    }

    content.unresolved.forEach((tag) =>
      plan.problems.push(
        name + ": line " + tag.line + ": cannot rewrite " + tag.before
      )
    );

    const changes = content.changes.concat(parts.changes);
    const staleRetrieve =
      retrievesFolder(view.retrieve) ||
      retrievesFolder(parseTemplate(view.content || "").retrieve);

    if (changes.length || staleRetrieve) {
      plan.views.push({
        view,
        content: content.content,
        partials: parts.partials,
        changes,
        staleRetrieve,
      });
    }
  }

  if (template.localEditing) await planFolderFiles(blog, template, views, plan);

  return plan;
}

// The template's directory in the blog's folder: the one whose name makes
// this template's ID (readFromFolder), in either "Templates" or "templates"
async function findTemplateDirectory(blog, template) {
  const { folder, makeID } = models();

  for (const root of ["Templates", "templates"]) {
    let entries;

    try {
      entries = await folder.listNames(blog.id, "/" + root);
    } catch (err) {
      continue;
    }

    const match = entries.find(
      (entry) =>
        entry.isDirectory && makeID(blog.id, entry.name) === template.id
    );

    if (match) return posix.join("/", root, match.name);
  }

  return null;
}

async function readText(blog, path) {
  const { folder } = models();

  try {
    return (await folder.read(blog.id, path)).toString("utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function planFolderFiles(blog, template, views, plan) {
  const dir = await findTemplateDirectory(blog, template);

  if (!dir) {
    plan.problems.push("locally edited, but its folder was not found");
    return;
  }

  plan.directory = dir;

  for (const name of Object.keys(views).sort()) {
    const path = posix.join(dir, name);
    let text;

    try {
      text = await readText(blog, path);
    } catch (err) {
      plan.problems.push(path + ": cannot read: " + err.message);
      continue;
    }

    if (text === null) continue;

    let rewritten;

    try {
      rewritten = rewriteFolderTags(text);
    } catch (err) {
      plan.problems.push(path + ": cannot parse: " + err.message);
      continue;
    }

    rewritten.unresolved.forEach((tag) =>
      plan.problems.push(
        path + ": line " + tag.line + ": cannot rewrite " + tag.before
      )
    );

    if (rewritten.changes.length)
      plan.files.push({
        path,
        content: rewritten.content,
        changes: rewritten.changes,
      });
  }

  // Inline partials live in package.json
  const packagePath = posix.join(dir, "package.json");
  let packageText;

  try {
    packageText = await readText(blog, packagePath);
  } catch (err) {
    plan.problems.push(packagePath + ": cannot read: " + err.message);
    return;
  }

  if (packageText === null) return;

  let pkg;

  try {
    pkg = JSON.parse(packageText);
  } catch (err) {
    return; // The sync reports an invalid package.json itself
  }

  const changes = [];

  for (const name of Object.keys((pkg && pkg.views) || {})) {
    const viewPackage = pkg.views[name];

    if (!viewPackage || typeof viewPackage !== "object") continue;

    // An explicit dependency would bring `folder` back on the next sync
    const retrieve = viewPackage.retrieve;
    if (
      retrieve &&
      typeof retrieve === "object" &&
      retrieve[FROM] !== undefined
    ) {
      if (retrieve[TO] === undefined) retrieve[TO] = retrieve[FROM];
      delete retrieve[FROM];
      changes.push({
        view: name,
        line: 0,
        before: "retrieve." + FROM,
        after: "retrieve." + TO,
      });
    }

    if (typeof viewPackage.partials !== "object" || !viewPackage.partials)
      continue;

    const rewritten = rewritePartials(viewPackage.partials);
    if (!rewritten.changes.length) continue;

    viewPackage.partials = rewritten.partials;
    rewritten.changes.forEach((change) =>
      changes.push(Object.assign({ view: name }, change))
    );
  }

  if (changes.length)
    plan.packageFile = {
      path: packagePath,
      content:
        JSON.stringify(pkg, null, 2) + (/\n$/.test(packageText) ? "\n" : ""),
      changes,
    };
}

// Saves a view with rewritten content through the template model, in place:
// nothing is deleted, so stopping part way leaves every view whole. setView
// keeps a stored retrieve local the parser can't see, so `folder: false`
// asks it to drop the stored `folder` (util/applyUserRetrieveOptions).
async function replaceView(templateID, item) {
  const { Template } = models();
  const old = item.view;
  const updates = {
    name: old.name,
    content: item.content,
    partials: item.partials,
    locals: old.locals || {},
    retrieve: Object.assign({}, old.retrieve, { [FROM]: false }),
  };

  if (Array.isArray(old.urlPatterns) && old.urlPatterns.length)
    updates.url = old.urlPatterns;
  else if (old.url) updates.url = old.url;

  await Template.setView(templateID, updates);
}

// Reads a saved view back: it must retrieve no `folder`, and `folder_legacy`
// when its own content now names it
async function verifyView(templateID, item) {
  const { Template } = models();
  const saved = await Template.getView(templateID, item.view.name);

  if (retrievesFolder(saved.retrieve))
    throw new Error(item.view.name + " still retrieves " + FROM);

  const contentNamesLegacy = item.changes.some((change) => !change.partial);

  if (contentNamesLegacy && !saved.retrieve[TO])
    throw new Error(item.view.name + " does not retrieve " + TO);
}

function formatChange(change) {
  const where = [];
  if (change.partial) where.push("partial " + change.partial);
  if (change.inside && change.inside.length)
    where.push("inside {{#" + change.inside.join("}}{{#") + "}}");

  return (
    "      line " +
    change.line +
    ": " +
    change.before +
    " -> " +
    change.after +
    (where.length ? " (" + where.join(", ") + ")" : "")
  );
}

function printPlan(plan, apply) {
  for (const item of plan.views) {
    const label = item.changes.length
      ? "view " + item.view.name
      : "view " + item.view.name + " (stored retrieve only)";
    console.log("    " + label);
    item.changes.forEach((change) => console.log(formatChange(change)));
  }

  for (const file of plan.files) {
    console.log("    folder file " + file.path);
    file.changes.forEach((change) => console.log(formatChange(change)));
  }

  if (plan.packageFile) {
    console.log("    folder file " + plan.packageFile.path);
    plan.packageFile.changes.forEach((change) =>
      console.log(formatChange(change))
    );
  }

  plan.problems.forEach((problem) => console.log("    PROBLEM " + problem));
  if (!apply && (plan.views.length || plan.files.length))
    console.log("    (dry run: nothing written)");
}

// Plans, and with apply writes, one template. Resolves with
// { id, installed, local, changed, failures }.
async function migrateTemplate(blog, template, { apply = false } = {}) {
  const { withFolderLock } = models();
  const installed = !!blog && blog.template === template.id;
  const local = !!template.localEditing;
  const result = {
    id: template.id,
    installed,
    local,
    changed: 0,
    failures: [],
  };

  // A locally edited template is planned and written under its folder lock,
  // so a dashboard save or sync waiting on the lock can't land between the
  // reads and the writes and be overwritten by them
  if (apply && local) {
    try {
      await withFolderLock(() => planAndWrite(blog, template, result, apply))(
        blog.id,
        template.id
      );
    } catch (err) {
      result.failures.push(err.message);
    }
  } else {
    await planAndWrite(blog, template, result, apply);
  }

  return result;
}

async function planAndWrite(blog, template, result, apply) {
  const plan = await planTemplate(blog, template);
  result.failures.push(...plan.problems);

  if (!plan.views.length && !plan.files.length && !plan.packageFile) {
    if (plan.problems.length) {
      printHeader(result);
      printPlan(plan, apply);
    }

    return result;
  }

  printHeader(result);
  printPlan(plan, apply);

  if (!apply) {
    result.changed = plan.views.length;
    return result;
  }

  const { blogFolder } = models();

  // The folder first, then Redis (under the lock for a locally edited
  // template), so a sync can't rebuild the template from old files between
  for (const file of [...plan.files, plan.packageFile].filter(Boolean)) {
    try {
      await blogFolder.write(blog, file.path, file.content);
      console.log("    wrote " + file.path);
    } catch (err) {
      result.failures.push(file.path + ": write failed: " + err.message);
    }
  }

  for (const item of plan.views) {
    try {
      await replaceView(template.id, item);
      await verifyView(template.id, item);
      result.changed++;
      console.log("    saved " + item.view.name);
    } catch (err) {
      result.failures.push(item.view.name + ": " + err.message);
    }
  }

  return result;
}

function printHeader(result) {
  console.log(
    "  " +
      result.id +
      " (installed: " +
      (result.installed ? "yes" : "no") +
      ", locally edited: " +
      (result.local ? "yes" : "no") +
      ")"
  );
}

// Calls fn(blog, template) for each template the blogs named in `filters`
// (handles, blog IDs or template IDs) own, or every blog's when there are none
async function eachSelectedTemplate(filters, fn) {
  const { Template } = models();

  if (!filters.length) {
    const eachTemplate = require("../each/template");
    await eachTemplate((user, blog, template) => fn(blog, template));
    return;
  }

  const getBlog = require("../get/blog");
  const wanted = new Map();

  for (const filter of filters) {
    const blogKey = filter.includes(":") ? filter.split(":")[0] : filter;
    let blog;

    try {
      ({ blog } = await getBlog(blogKey));
    } catch (err) {
      // reported below
    }

    if (!blog) throw new Error("No blog or template: " + filter);

    if (!wanted.has(blog.id)) wanted.set(blog.id, { blog, ids: new Set() });
    if (filter.includes(":")) wanted.get(blog.id).ids.add(filter);
  }

  for (const { blog, ids } of wanted.values()) {
    const templates = (await Template.getTemplateList(blog.id)).filter(
      (template) =>
        template.owner === blog.id && (!ids.size || ids.has(template.id))
    );

    for (const template of templates) await fn(blog, template);
  }
}

async function main(argv) {
  const apply = argv.includes("--apply");
  const filters = argv.filter((arg) => !arg.startsWith("--"));
  const totals = { templates: 0, affected: 0, changed: 0, failures: [] };

  console.log(
    apply ? "Applying" : "Dry run (pass --apply to write)",
    filters.length ? "for " + filters.join(", ") : "for every template"
  );

  await eachSelectedTemplate(filters, async (blog, template) => {
    totals.templates++;

    try {
      const result = await migrateTemplate(blog, template, { apply });
      if (result.changed || result.failures.length) totals.affected++;
      totals.changed += result.changed;
      result.failures.forEach((failure) =>
        totals.failures.push(result.id + ": " + failure)
      );
    } catch (err) {
      totals.failures.push(template.id + ": " + err.message);
      console.error("  Error migrating " + template.id, err);
    }
  });

  // Bundled templates are never changed here, but none may use `folder`
  if (!filters.length) {
    const { Template } = models();
    const bundled = (await Template.getTemplateList("SITE")).filter(
      (template) => template.owner === "SITE"
    );

    for (const template of bundled) {
      const plan = await planTemplate(null, Object.assign({}, template));
      if (plan.views.length)
        totals.failures.push(
          template.id +
            ": bundled template names " +
            FROM +
            " in " +
            plan.views.map((item) => item.view.name).join(", ")
        );
    }
  }

  console.log(
    (apply ? "Saved" : "Would save") +
      " " +
      totals.changed +
      " views in " +
      totals.affected +
      " of " +
      totals.templates +
      " templates; failures: " +
      totals.failures.length
  );

  if (apply) {
    // Nothing may still name `folder`, in Redis or in a locally edited folder
    const remaining = [];

    await eachSelectedTemplate(filters, async (blog, template) => {
      const plan = await planTemplate(blog, template);
      plan.views.forEach((item) =>
        remaining.push(template.id + ": view " + item.view.name)
      );
      plan.files.forEach((file) =>
        remaining.push(template.id + ": folder file " + file.path)
      );
      if (plan.packageFile)
        remaining.push(template.id + ": folder file " + plan.packageFile.path);
    });

    console.log(
      "Re-scan: " + remaining.length + " views or files still name " + FROM
    );
    remaining.forEach((line) => console.log("  " + line));
    totals.failures.push(
      ...remaining.map((line) => "still names " + FROM + ": " + line)
    );
  }

  totals.failures.forEach((failure) => console.error("FAILED " + failure));

  return totals.failures.length ? 1 : 0;
}

module.exports = {
  rewriteFolderTags,
  rewritePartials,
  planTemplate,
  migrateTemplate,
  main,
};

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
