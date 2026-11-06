var ensure = require("helper/ensure");
var folder = require("storage/folder");
var readFromFolder = require("./readFromFolder");
var getTemplateList = require("./getTemplateList");
var drop = require("./drop");
var withCallback = require("helper/withCallback");
var folderRenames = require("./folderRenames");
var renameLocalTemplate = require("./renameLocalTemplate");
var makeID = require("./util/makeID");
var getMetadata = require("./getMetadata");
var setMetadata = require("./setMetadata");
var Blog = require("models/blog");
var defaults = require("models/blog/defaults");

const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
var clfdate = require("helper/clfdate");

module.exports = withCallback(async function buildFromFolder(blogID) {
  ensure(blogID, "string");

  var templateDirs = ["/templates", "/Templates"];

  const templatesInFolder = [];

  // Reading a folder whose package.json says `enabled` installs it, so note
  // which template was installed before we scan
  var installedBefore;

  try {
    var blog = await Blog.get({ id: blogID });
    installedBefore = blog && blog.template;
  } catch (err) {
    installedBefore = null;
  }

  for (const templateDir of templateDirs) {
    let entries;

    try {
      entries = await folder.listNames(blogID, templateDir);
    } catch (err) {
      continue;
    }

    if (!entries) continue;

    const templates = entries.map(function (entry) {
      return entry.name;
    });

    for (const template of templates) {
      if (template.startsWith(".") || shouldIgnoreFile(template)) continue;

      const dir = templateDir + "/" + template;

      console.log(
        clfdate(),
        blogID.slice(0, 12),
        "buildFromFolder: reading template",
        dir
      );
      const id = makeID(blogID, template);

      let existing;
      let metadataFailed = false;

      try {
        existing = await getMetadata(id);
      } catch (metadataErr) {
        metadataFailed = true;
      }

      const isNew = metadataFailed || !existing;
      let readFailed = false;

      try {
        await readFromFolder(blogID, dir);
      } catch (err) {
        readFailed = true;

        // we need to expose this error
        // on the design page!
        console.log(
          clfdate(),
          blogID.slice(0, 12),
          "buildFromFolder: failed to read template",
          dir,
          err
        );
      }

      templatesInFolder.push(template);

      if (readFailed) continue;

      // A case-only rename is the same template (ids are
      // lowercased) but writeToFolder and removeFromFolder build
      // paths from the slug, so keep it in step with the directory
      if (
        !isNew &&
        existing.slug !== template &&
        String(existing.slug).toLowerCase() === template.toLowerCase()
      ) {
        try {
          await setMetadata(id, { slug: template });
        } catch (err) {
          // ignored, as before
        }

        continue;
      }

      if (!isNew) continue;

      try {
        await folderRenames.markFresh(blogID, id);
      } catch (err) {
        console.error(
          clfdate(),
          blogID.slice(0, 12),
          "buildFromFolder: failed to record new template",
          id,
          err
        );
      }
    }
  }

  console.log(
    clfdate(),
    blogID.slice(0, 12),
    "buildFromFolder: templates in folder",
    templatesInFolder.length
  );
  console.log(
    clfdate(),
    blogID.slice(0, 12),
    "buildFromFolder: removing local templates not in folder"
  );

  try {
    await removeMissing(blogID, templatesInFolder, installedBefore);
    console.log(clfdate(), blogID.slice(0, 12), "buildFromFolder: complete");
  } catch (err) {
    console.error(
      clfdate(),
      blogID.slice(0, 12),
      "buildFromFolder: failed to remove templates",
      err
    );
  }
});

// Removes local templates whose folder has gone missing. The installed one
// might have been renamed rather than deleted, so we hold off for
// RENAME_WINDOW and, if a newly created template that resembles it appears in
// that time, migrate to that instead. If none does we install the default
// template so the site and template editor keep working.
async function templateExists(id) {
  try {
    return !!(await getMetadata(id));
  } catch (err) {
    return false;
  }
}

async function removeMissing(blogID, templatesInFolder, installedBefore) {
  const log = (...args) =>
    console.log(clfdate(), blogID.slice(0, 12), "buildFromFolder:", ...args);
  const templates = (await getTemplateList(blogID)) || [];
  const blog = await Blog.get({ id: blogID });
  const now = Date.now();

  const local = templates.filter(
    (template) => template.localEditing === true && template.owner === blogID
  );

  // Folders and templates are matched by id, not slug: makeID lowercases, so a
  // folder renamed only in case is still the same template
  const idsInFolder = templatesInFolder.map((name) => makeID(blogID, name));
  const orphans = local.filter(
    (template) => !idsInFolder.includes(template.id)
  );

  // Templates which aren't installed can be dropped straight away
  for (const orphan of orphans.filter(
    (template) => template.id !== installedBefore
  )) {
    try {
      log("removing template", orphan.slug);
      await drop(blogID, orphan.slug);
    } catch (err) {
      console.error(
        clfdate(),
        blogID.slice(0, 12),
        "buildFromFolder: failed to remove template",
        orphan.slug,
        err
      );
    }
  }

  const installed = orphans.find((template) => template.id === installedBefore);

  // Forget any pending record which no longer applies
  const pending = await folderRenames.readPending(blogID);
  for (const id of Object.keys(pending)) {
    if (!installed || id !== installed.id)
      await folderRenames.clear(blogID, id);
  }

  if (!installed) return;

  try {
    let record = pending[installed.id];

    if (!record) {
      record = {
        since: now,
        views: await folderRenames.viewHashes(installed.id),
      };
      await folderRenames.setPending(blogID, installed.id, record);
    }

    const fresh = await folderRenames.readFresh(blogID);
    let best,
      bestScore = 0,
      tied = false;

    for (const template of local) {
      if (template.id === installed.id) continue;
      if (!idsInFolder.includes(template.id)) continue;

      // Only a template created around the time the folder went missing
      // (before or after) can be its rename
      if (
        !(
          Math.abs(fresh[template.id] - record.since) <
          folderRenames.RENAME_WINDOW
        )
      )
        continue;

      const score = folderRenames.similarity(
        record.views,
        await folderRenames.viewHashes(template.id)
      );

      if (score > bestScore) {
        best = template;
        bestScore = score;
        tied = false;
      } else if (score === bestScore) {
        tied = true;
      }
    }

    if (best && bestScore > folderRenames.MIN_SIMILARITY && !tied) {
      log("installed template folder renamed", installed.id, "->", best.id);
      await renameLocalTemplate(blogID, installed.id, best.id);
      await folderRenames.clear(blogID, installed.id);
      await folderRenames.clear(blogID, best.id);
    } else if (blog.template !== installed.id) {
      // Something else was installed in the meantime (e.g. the new folder's
      // package.json said `enabled`), so nothing points at this one
      log("removing template", installed.slug);
      await drop(blogID, installed.slug);
      await folderRenames.clear(blogID, installed.id);
    } else if (now - record.since >= folderRenames.RENAME_WINDOW) {
      log(
        "installed template folder missing, installing default",
        installed.id
      );

      // Drop first: installing the default forks it as a blog-owned template
      // named after it, and if that's the id of the template being removed
      // (a local edit of the default theme) the fork would reuse and then
      // delete it, leaving the blog pointing at nothing.
      try {
        await drop(blogID, installed.slug);
      } catch (dropErr) {
        // drop can fail after it has deleted the template (its last step
        // bumps the blog's cacheID). If the template is gone the blog must
        // still be moved off it; if it's intact, retry on the next sync.
        if (await templateExists(installed.id)) throw dropErr;
        console.error(
          clfdate(),
          blogID.slice(0, 12),
          "buildFromFolder: error after dropping template",
          installed.slug,
          dropErr
        );
      }

      await Blog.set(blogID, { template: defaults.template });
      await folderRenames.clear(blogID, installed.id);
    } else {
      log(
        "installed template folder missing, waiting to see if it was renamed",
        installed.slug
      );
    }
  } catch (err) {
    console.error(
      clfdate(),
      blogID.slice(0, 12),
      "buildFromFolder: failed to handle missing installed template",
      installed.slug,
      err
    );
  }
}
