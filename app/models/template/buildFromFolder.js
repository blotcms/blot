var ensure = require("helper/ensure");
var localPath = require("helper/localPath");
var fs = require("fs-extra");
var readFromFolder = require("./readFromFolder");
var async = require("async");
var getTemplateList = require("./getTemplateList");
var drop = require("./drop");
var promisify = require("util").promisify;
var folderRenames = require("./folderRenames");
var renameLocalTemplate = require("./renameLocalTemplate");
var makeID = require("./util/makeID");
var getMetadata = require("./getMetadata");
var setMetadata = require("./setMetadata");
var Blog = require("models/blog");
var defaults = require("models/blog/defaults");

var getBlog = promisify(Blog.get);
var setBlog = promisify(Blog.set);

var dropTemplate = promisify(drop);
var getTemplateList_ = promisify(getTemplateList);
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
var clfdate = require("helper/clfdate");

module.exports = function (blogID, callback) {
  ensure(blogID, "string").and(callback, "function");

  var templateDirs = [
    localPath(blogID, "/templates"),
    localPath(blogID, "/Templates")
  ];

  const templatesInFolder = [];

  // Reading a folder whose package.json says `enabled` installs it, so note
  // which template was installed before we scan
  getBlog({ id: blogID }).then(function (blog) {
    scan(blog && blog.template);
  }, function () {
    scan(null);
  });

  function scan(installedBefore) {
  async.eachSeries(
    templateDirs,
    function (templateDir, next) {
      fs.readdir(templateDir, function (err, templates) {
        if (err || !templates) return next();

        async.eachSeries(
          templates,
          function (template, next) {
            if (template.startsWith('.') || shouldIgnoreFile(template)) return next();

            var dir = templateDir + "/" + template;

            console.log(clfdate(), blogID.slice(0, 12), "buildFromFolder: reading template", dir);
            var id = makeID(blogID, template);

            getMetadata(id, function (metadataErr, existing) {
              var isNew = !!metadataErr || !existing;

              readFromFolder(blogID, dir, function (err) {
                if (err) {
                  // we need to expose this error
                  // on the design page!
                  console.log(clfdate(), blogID.slice(0, 12), "buildFromFolder: failed to read template", dir, err);
                }

                templatesInFolder.push(template);

                if (err) return next();

                // A case-only rename is the same template (ids are
                // lowercased) but writeToFolder and removeFromFolder build
                // paths from the slug, so keep it in step with the directory
                if (!isNew && existing.slug !== template && String(existing.slug).toLowerCase() === template.toLowerCase()) {
                  return setMetadata(id, { slug: template }, function () { next(); });
                }

                if (!isNew) return next();

                folderRenames.markFresh(blogID, id).then(
                  function () { next(); },
                  function (err) {
                    console.error(clfdate(), blogID.slice(0, 12), "buildFromFolder: failed to record new template", id, err);
                    next();
                  }
                );
              });
            });
          },
          next
        );
      });
    },
    function (err) {
      console.log(clfdate(), blogID.slice(0, 12), "buildFromFolder: templates in folder", templatesInFolder.length);
      console.log(clfdate(), blogID.slice(0, 12), "buildFromFolder: removing local templates not in folder");

      removeMissing(blogID, templatesInFolder, installedBefore).then(
        function () {
          console.log(clfdate(), blogID.slice(0, 12), "buildFromFolder: complete");
          callback(null);
        },
        function (err) {
          console.error(clfdate(), blogID.slice(0, 12), "buildFromFolder: failed to remove templates", err);
          callback();
        }
      );
    }
  );
  }
};

// Removes local templates whose folder has gone missing. The installed one
// might have been renamed rather than deleted, so we hold off for
// RENAME_WINDOW and, if a newly created template that resembles it appears in
// that time, migrate to that instead. If none does we install the default
// template so the site and template editor keep working.
function templateExists(id) {
  return new Promise(function (resolve) {
    getMetadata(id, function (err, metadata) {
      resolve(!err && !!metadata);
    });
  });
}

async function removeMissing(blogID, templatesInFolder, installedBefore) {
  const log = (...args) => console.log(clfdate(), blogID.slice(0, 12), "buildFromFolder:", ...args);
  const templates = (await getTemplateList_(blogID)) || [];
  const blog = await getBlog({ id: blogID });
  const now = Date.now();

  const local = templates.filter(
    template => template.localEditing === true && template.owner === blogID
  );

  // Folders and templates are matched by id, not slug: makeID lowercases, so a
  // folder renamed only in case is still the same template
  const idsInFolder = templatesInFolder.map(name => makeID(blogID, name));
  const orphans = local.filter(template => !idsInFolder.includes(template.id));

  // Templates which aren't installed can be dropped straight away
  for (const orphan of orphans.filter(template => template.id !== installedBefore)) {
    try {
      log("removing template", orphan.slug);
      await dropTemplate(blogID, orphan.slug);
    } catch (err) {
      console.error(clfdate(), blogID.slice(0, 12), "buildFromFolder: failed to remove template", orphan.slug, err);
    }
  }

  const installed = orphans.find(template => template.id === installedBefore);

  // Forget any pending record which no longer applies
  const pending = await folderRenames.readPending(blogID);
  for (const id of Object.keys(pending)) {
    if (!installed || id !== installed.id) await folderRenames.clear(blogID, id);
  }

  if (!installed) return;

  try {
    let record = pending[installed.id];

    if (!record) {
      record = { since: now, views: await folderRenames.viewHashes(installed.id) };
      await folderRenames.setPending(blogID, installed.id, record);
    }

    const fresh = await folderRenames.readFresh(blogID);
    let best, bestScore = 0, tied = false;

    for (const template of local) {
      if (template.id === installed.id) continue;
      if (!idsInFolder.includes(template.id)) continue;

      // Only a template created around the time the folder went missing
      // (before or after) can be its rename
      if (!(Math.abs(fresh[template.id] - record.since) < folderRenames.RENAME_WINDOW)) continue;

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
      await dropTemplate(blogID, installed.slug);
      await folderRenames.clear(blogID, installed.id);
    } else if (now - record.since >= folderRenames.RENAME_WINDOW) {
      log("installed template folder missing, installing default", installed.id);

      // Drop first: installing the default forks it as a blog-owned template
      // named after it, and if that's the id of the template being removed
      // (a local edit of the default theme) the fork would reuse and then
      // delete it, leaving the blog pointing at nothing.
      try {
        await dropTemplate(blogID, installed.slug);
      } catch (dropErr) {
        // drop can fail after it has deleted the template (its last step
        // bumps the blog's cacheID). If the template is gone the blog must
        // still be moved off it; if it's intact, retry on the next sync.
        if (await templateExists(installed.id)) throw dropErr;
        console.error(clfdate(), blogID.slice(0, 12), "buildFromFolder: error after dropping template", installed.slug, dropErr);
      }

      await setBlog(blogID, { template: defaults.template });
      await folderRenames.clear(blogID, installed.id);
    } else {
      log("installed template folder missing, waiting to see if it was renamed", installed.slug);
    }
  } catch (err) {
    console.error(clfdate(), blogID.slice(0, 12), "buildFromFolder: failed to handle missing installed template", installed.slug, err);
  }
}
