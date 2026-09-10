var path = require("path");
var fs = require("fs-extra");
var { promisify } = require("util");

var makeID = require("./makeID");
var localPath = require("helper/localPath");
var setMetadata = require("../setMetadata");
var getMetadata = require("../getMetadata");
var getTemplateList = require("../getTemplateList");
var Blog = require("models/blog");
var shouldIgnoreFile = require("clients/util/shouldIgnoreFile");

// buildFromFolder scans both of these; writeToFolder writes to whichever
// determineTemplateFolder picks. A stale directory could be under either.
var TEMPLATE_ROOTS = ["Templates", "templates"];

function idSuffix(id) {
  var i = String(id).indexOf(":");
  return i === -1 ? "" : String(id).slice(i + 1);
}

// A slug is safe to use as a single on-disk path component only if it has no
// separators and does not climb out of its directory.
function isSafeComponent(slug) {
  return (
    typeof slug === "string" &&
    slug.length > 0 &&
    slug !== "." &&
    slug !== ".." &&
    slug.indexOf("/") === -1 &&
    slug.indexOf("\\") === -1
  );
}

// Resolve <root>/<slug> and confirm it lands directly inside <root> of the
// blog's folder. Returns the absolute path, or null when the slug is unsafe.
function safeDir(blogID, root, slug) {
  if (!isSafeComponent(slug)) return null;
  var rootAbs = localPath(blogID, root);
  var abs = localPath(blogID, path.join(root, slug));
  if (path.dirname(abs) !== rootAbs) return null;
  return abs;
}

// A blot-folder-relative path for a client call. Always leading-slashed:
// git and dropbox strip the slash themselves, but google-drive's write adds
// one (so its file-id database is keyed with it) while its remove does not —
// pass the slashed form so removals actually match. See clients/google-drive.
function clientPath() {
  var parts = Array.prototype.slice.call(arguments).filter(Boolean);
  return "/" + parts.join("/");
}

// Pure classification of a template's stored slug against its id.
//   { divergent: false }
//   { divergent: true, repairable: false, reason }   -> needs a manual rename
//   { divergent: true, repairable: true, target }    -> target is the new slug
function classify(blogID, template) {
  var slug = template && template.slug;
  var resolved;

  try {
    resolved = makeID(blogID, slug);
  } catch (e) {
    return {
      divergent: true,
      repairable: false,
      reason:
        "stored slug " + JSON.stringify(slug) + " is not a usable name (" +
        e.message + ")",
    };
  }

  if (resolved === template.id) return { divergent: false };

  // The slug we want is the id's own suffix — but only when makeID maps it
  // straight back to the id. A legacy id minted from a non-ASCII name (before
  // makeID capped length / percent-encoded it) will not round-trip and cannot
  // be repaired safely here.
  var target = idSuffix(template.id);

  if (!target || makeID(blogID, target) !== template.id) {
    return {
      divergent: true,
      repairable: false,
      reason:
        "id " + template.id + " has no suffix that makeID maps back to it — " +
        "rename the template by hand",
    };
  }

  return { divergent: true, repairable: true, target: target };
}

// Walk absDir asynchronously (so the sync-lock heartbeat keeps running on very
// large trees) and report what it holds. Returns:
//   { files, hasSymlink, hasExecutable, empty }
// files are "/"-joined paths relative to absDir, regular files only. dotfiles
// are included; symlinks and executables are flagged, not listed — a tree with
// either is refused rather than moved lossily (the copy cannot reproduce them
// and the subsequent client.remove would commit their deletion).
async function scanTree(absDir) {
  var files = [];
  var hasSymlink = false;
  var hasExecutable = false;

  async function walk(dir, rel) {
    var entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") return;
      throw e;
    }

    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var childAbs = path.join(dir, entry.name);
      var childRel = rel ? rel + "/" + entry.name : entry.name;

      if (entry.isSymbolicLink()) {
        hasSymlink = true;
        continue;
      }
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
        continue;
      }
      if (entry.isFile()) {
        files.push(childRel);
        try {
          var st = await fs.stat(childAbs);
          if (st.mode & 0o111) hasExecutable = true;
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
      }
    }
  }

  await walk(absDir, "");

  return {
    files: files,
    hasSymlink: hasSymlink,
    hasExecutable: hasExecutable,
    empty: files.length === 0,
  };
}

// Copy each listed file from srcAbs/<rel> to <destRelClient>/<rel> through the
// blog's client (so the move reaches the provider); fall back to a plain disk
// write for a blog with no client. Only reached for trees scanTree accepted,
// so no symlinks or executables are in play. shouldIgnoreFile entries are
// local-only for every non-git client (client.write refuses them and Blot
// never syncs them out), and git blogs are refused wholesale upstream, so
// those are written straight to disk.
async function copyFiles(blogID, client, files, srcAbs, destRelClient) {
  for (var i = 0; i < files.length; i++) {
    var rel = files[i];
    var destFileRel = destRelClient + "/" + rel;
    var contents = await fs.readFile(path.join(srcAbs, rel));

    if (client && !shouldIgnoreFile(destFileRel)) {
      await promisify(client.write)(blogID, destFileRel, contents);
    } else {
      await fs.outputFile(localPath(blogID, destFileRel), contents);
    }
  }
}

// Remove the stale directory through the client (so the provider drops it),
// then fs.remove the now-empty local shell.
async function removeDir(blogID, client, oldRelClient, oldAbs) {
  if (client) {
    try {
      await promisify(client.remove)(blogID, oldRelClient);
    } catch (e) {
      if (!e || e.code !== "ENOENT") throw e;
    }
  }
  await fs.remove(oldAbs);
}

// Reconcile one template whose stored slug no longer resolves to its id.
//
// The caller is responsible for holding establishSyncLock(blog.id) around this
// so no buildFromFolder runs against a half-migrated state.
//
// Returns one of:
//   { skipped: true, reason }              nothing to do / needs a manual hand
//   { skipped: true, collision: true, reason }
//   { wouldRepair: true }                  dry run, a repair is available
//   { repaired: true }                     applied
//
// Throws only on an unexpected folder / metadata error. When the folder was
// already moved and the metadata write then fails, the stored slug is checked:
// if it did persist the move stands, otherwise the move is rolled back so a
// rerun retries identically and the lock's buildFromFolder never sees the
// folder name and the stored slug disagree.
async function repairDivergentSlug(blog, template, options) {
  options = options || {};
  var apply = options.apply === true;
  var log = typeof options.log === "function" ? options.log : function () {};

  var info = classify(blog.id, template);

  if (!info.divergent) return { skipped: true, reason: "slug already resolves" };
  if (!info.repairable) return { skipped: true, reason: info.reason };

  var oldSlug = template.slug;
  var target = info.target;

  // Constrain both slugs as path components before any filesystem access.
  var unsafe = TEMPLATE_ROOTS.some(function (root) {
    return (
      safeDir(blog.id, root, oldSlug) === null ||
      safeDir(blog.id, root, target) === null
    );
  });
  if (unsafe) {
    return {
      skipped: true,
      reason:
        "slug " + JSON.stringify(oldSlug) + " or " + JSON.stringify(target) +
        " is not a safe path component",
    };
  }

  var list = await promisify(getTemplateList)(blog.id);
  var owned = (list || []).filter(function (t) {
    return t.owner === blog.id;
  });

  // Leave every record involved for manual handling when another owned template
  // resolves to the stale id, stores the same stale slug, or already stores the
  // target slug — in each case two records would claim one physical directory.
  var staleID = makeID(blog.id, oldSlug);
  var collidesWith = owned.find(function (t) {
    return (
      t.id !== template.id &&
      (t.id === staleID || t.slug === oldSlug || t.slug === target)
    );
  });
  if (collidesWith) {
    return {
      skipped: true,
      collision: true,
      reason:
        "the " + JSON.stringify(oldSlug) + " / " + JSON.stringify(target) +
        " directory is also claimed by " + collidesWith.id + " — resolve by hand",
    };
  }

  // A git-backed blog needs `git mv` to relocate a tracked subtree: writing the
  // files at the new path and removing the old one through the client loses
  // tracked ignored files, changes 100755 modes to 100644, and rewrites history
  // needlessly. Refuse and leave it for a manual `git mv`.
  if (blog.client === "git") {
    return {
      skipped: true,
      reason:
        "git-backed blog: `git mv " + TEMPLATE_ROOTS[0] + "/" + oldSlug + " " +
        TEMPLATE_ROOTS[0] + "/" + target + "` by hand, then rerun",
    };
  }

  var client = require("clients")[blog.client] || null;

  // Find the stale directory under either root. A divergent record can have a
  // stale folder even with localEditing === false (the disable route sets the
  // flag even when removeFromFolder failed), so key off the actual directory,
  // not the flag.
  var found = [];

  for (var r = 0; r < TEMPLATE_ROOTS.length; r++) {
    var root = TEMPLATE_ROOTS[r];
    var fromAbs = safeDir(blog.id, root, oldSlug);
    var toAbs = safeDir(blog.id, root, target);
    var stat = null;

    try {
      stat = await fs.lstat(fromAbs);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }

    if (!stat) continue;

    // The stale entry must be a real directory. A symlink here would be left
    // in place by the move and then followed by buildFromFolder.
    if (!stat.isDirectory()) {
      return {
        skipped: true,
        reason:
          root + "/" + oldSlug + " is not a real directory — reconcile by hand",
      };
    }

    var scan = await scanTree(fromAbs);

    if (scan.hasSymlink) {
      return {
        skipped: true,
        reason: root + "/" + oldSlug + " contains a symlink — reconcile by hand",
      };
    }
    if (scan.hasExecutable) {
      return {
        skipped: true,
        reason:
          root + "/" + oldSlug +
          " contains an executable file — reconcile by hand",
      };
    }
    if (scan.empty) {
      return {
        skipped: true,
        reason: root + "/" + oldSlug + " is empty — reconcile by hand",
      };
    }

    // An existing destination must be a real directory too (never a symlink or
    // file) before we treat it as a resumable prior move and write into it.
    var destStat = null;
    try {
      destStat = await fs.lstat(toAbs);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (destStat && !destStat.isDirectory()) {
      return {
        skipped: true,
        collision: true,
        reason:
          root + "/" + target + " exists and is not a real directory — " +
          "resolve by hand",
      };
    }

    found.push({
      root: root,
      fromAbs: fromAbs,
      toAbs: toAbs,
      files: scan.files,
      resuming: !!destStat,
    });
  }

  // A locally edited template with no folder on disk is already headed for
  // buildFromFolder's cleanup regardless of its slug — don't report it as
  // repaired, flag it for a look.
  if (!found.length && template.localEditing) {
    return {
      skipped: true,
      reason:
        "localEditing template has no folder under Templates/ or templates/ " +
        "— reconcile by hand",
    };
  }

  log(
    (apply ? "FIX  " : "WOULD FIX ") + blog.id + " " + template.id +
    "  " + JSON.stringify(oldSlug) + " -> " + JSON.stringify(target) +
    "  (localEditing=" + !!template.localEditing +
    ", onDisk=" +
    (found.length
      ? found
          .map(function (f) {
            return f.root + (f.resuming ? " (resuming)" : "");
          })
          .join("+")
      : "none") +
    ")"
  );

  if (!apply) return { wouldRepair: true };

  var moved = [];

  async function rollback() {
    for (var m = moved.length - 1; m >= 0; m--) {
      var mv = moved[m];
      try {
        var back = await scanTree(mv.toAbs);
        await copyFiles(
          blog.id,
          client,
          back.files,
          mv.toAbs,
          clientPath(mv.root, oldSlug)
        );
        await removeDir(
          blog.id,
          client,
          clientPath(mv.root, target),
          mv.toAbs
        );
      } catch (rollbackErr) {
        log(
          "  ROLLBACK FAILED " + mv.root + "/" + target + " -> " + mv.root +
          "/" + oldSlug + ": " + rollbackErr.message + " — reconcile by hand"
        );
      }
    }
  }

  // Move every stale directory before persisting the slug.
  try {
    for (var f = 0; f < found.length; f++) {
      var fromRoot = found[f].root;
      moved.push({ root: fromRoot, toAbs: found[f].toAbs });
      await copyFiles(
        blog.id,
        client,
        found[f].files,
        found[f].fromAbs,
        clientPath(fromRoot, target)
      );
      await removeDir(
        blog.id,
        client,
        clientPath(fromRoot, oldSlug),
        found[f].fromAbs
      );
    }
  } catch (e) {
    await rollback();
    throw e;
  }

  // The folder is durable under the new name (or there was no folder) — only
  // now correct the stored slug.
  try {
    await promisify(setMetadata)(template.id, { slug: target });
  } catch (e) {
    // setMetadata writes the hash before its own fallible follow-ups
    // (cacheID bump, CDN manifest). If the slug did persist, the folder
    // already matches it — keep the move. Otherwise roll back.
    var current = null;
    try {
      current = await promisify(getMetadata)(template.id);
    } catch (readErr) {
      current = null;
    }
    if (!current || current.slug !== target) {
      await rollback();
      throw e;
    }
    log(
      "  setMetadata errored after persisting the slug (" + e.message +
      ") — folder already matches, keeping the move"
    );
  }

  // setMetadata already bumps cacheID for a blog-owned template; do it
  // explicitly too so the repair is self-contained.
  try {
    await promisify(Blog.set)(blog.id, { cacheID: Date.now() });
  } catch (e) {
    // non-fatal: the slug and folder are already consistent
  }

  return { repaired: true };
}

module.exports = repairDivergentSlug;
module.exports.classify = classify;
module.exports.TEMPLATE_ROOTS = TEMPLATE_ROOTS;
