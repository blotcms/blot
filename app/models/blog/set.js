var key = require("./key");
var _ = require("lodash");
var ensure = require("helper/ensure");
var TYPE = require("./scheme").TYPE;
var validate = require("./validate");
var get = require("./get");
var serial = require("./serial");
var client = require("models/client");
var config = require("config");
var BackupDomain = require("./util/backupDomain");
var flushCache = require("./flushCache");
var normalizeImageExif = require("./util/imageExif").normalize;
var normalizeConverters = require("./util/converters").normalize;
var updateCdnManifest = require("../template/util/updateCdnManifest");
var forkSiteTemplate = require("../template/util/forkSiteTemplate");
var renameGitRepo = require("clients/git/renameRepo");
var serializeRedisHashValues = require("models/redisHashSerializer");
var promisify = require("util").promisify;
var updateCdnManifestAsync = promisify(updateCdnManifest);

function Changes(latest, former) {
  var changes = {};

  // Determine any changes to the user's info
  for (var i in latest)
    if (!_.isEqual(latest[i], former[i])) changes[i] = latest[i] = latest[i];

  return changes;
}

module.exports = function (blogID, blog, callback) {
  ensure(blogID, "string").and(callback, "function");

  var multi = client.multi();
  var formerBackupDomain, changes, backupDomain;
  var changesList = [];

  validate(blogID, blog, function (errors, latest) {
    if (errors) return callback(errors);

    get({ id: blogID }, async function (err, former) {
      former = former || {};

      if (err) return callback(err);

      var previousMode = (former && former.imageExif) || "off";

      if (Object.prototype.hasOwnProperty.call(latest, "imageExif")) {
        latest.imageExif = normalizeImageExif(latest.imageExif, {
          fallback: previousMode,
        });
      } else if (!former.imageExif) {
        latest.imageExif = normalizeImageExif(previousMode, {
          fallback: "off",
        });
      }

      if (Object.prototype.hasOwnProperty.call(latest, "converters")) {
        latest.converters = normalizeConverters(latest.converters, {
          fallback: former && former.converters,
        });
      } else if (!former.converters) {
        latest.converters = normalizeConverters(former && former.converters);
      }

      changes = Changes(latest, former);

      if (
        changes.template &&
        latest.template &&
        latest.template.indexOf("SITE:") === 0
      ) {
        try {
          var forkedTemplateID = await forkSiteTemplate(blogID, latest.template);

          if (forkedTemplateID && forkedTemplateID !== latest.template) {
            latest.template = forkedTemplateID;
            changes.template = forkedTemplateID;
          }
        } catch (forkError) {
          // for now, do nothing
          console.log('Blog.set', blogID, 'Error forking template', forkError);
        }
      }

      // Blot stores the rendered output of requests in a
      // cache directory, files inside which are served before
      // the rendering engine receives a request. We need to
      // work out which hosts are affected by this change and
      // then flush the cache directory for those hosts. Previously
      // I had just cleared the cache for the latest handle and the
      // latest domain, but this caused an issue when switching
      // from the 'www' domain to the apex domain. NGINX continued
      // to serve the old cached files for the 'www' subdomain instead
      // of passing the request to Blot to redirect as expected.
      if (changes.handle) {
        multi.set(key.handle(latest.handle), blogID);

        // By storing the handle + Blot's host as a 'domain' we
        // allow the SSL certificate generator to run for this.
        // Now we have certs on Blot subdomains!
        multi.set(key.domain(latest.handle + "." + config.host), blogID);

        // I don't delete the handle key for the former domain
        // so that we can redirect the former handle easily,
        // whilst leaving it free for other users to claim.
        if (former.handle) {
          multi.del(key.domain(former.handle + "." + config.host));
        }
      }

      // We check against empty string, because if the
      // user removes their domain from the page on the
      // dashboard, changes.domain will be an empty string
      var domainChanged = Object.prototype.hasOwnProperty.call(
        changes,
        "domain"
      );

      if (domainChanged) {
        var latestDomain = changes.domain;

        // We calculate a backup domain to check against
        // Lots of users have difficulty understanding the
        // difference between www.example.com and example.com
        // So we try and help them catch mistakes. This additional
        // backup domain means that when the user types in
        // example.com, but configures a CNAME record for www.example.com
        // then www.example.com will work. It also means that when
        // the user types in example.com, sets up an A or ALIAS record
        // then visits www.example.com, the domain will redirect.
        // I'm not sure if this is 'right' or 'correct' but it reduces
        // a good deal of frustration and confusion on the part of
        // Blot's customers. So it will remain for now.
        if (former.domain) {
          formerBackupDomain = BackupDomain(former.domain);
          multi.del(key.domain(former.domain));
          multi.del(key.domain(formerBackupDomain));
        }

        // Order is important, we must append the delete
        // actions to the multi command before the set
        // to ensure that when the user changes the domain
        // from www.example.com to example.com on the dashboard
        // we don't accidentally delete the new settings.
        if (latestDomain) {
          backupDomain = BackupDomain(latestDomain);
          multi.set(key.domain(latestDomain), blogID);
          multi.set(key.domain(backupDomain), blogID);
        }
      }

      // Check if we need to change user's css or js cache id
      // We sometimes manually pass in a new cache ID when we want
      // to bust the cache, e.g. in ./flushCache
      if (changes.template || changes.plugins || changes.cacheID || changes.menu) {
        const now = Date.now();
        const previousCacheID = Number(former.cacheID) || 0;
        latest.cacheID = Math.max(now, previousCacheID + 1);
        latest.cssURL = `/style.css?cache=${latest.cacheID}&amp;extension=.css`;
        latest.scriptURL = `/script.js?cache=${latest.cacheID}&amp;extension=.js`;
        changes.cacheID = true;
        changes.cssURL = true;
        changes.scriptURL = true;
      }

      // Verify that all the new info matches
      // strictly the type specification
      ensure(latest, TYPE);

      changesList = _.keys(changes);

      // There are no changes to save so finish now
      if (!changesList.length) {
        return callback(null, changesList);
      }

      multi.hSet(key.info(blogID), serializeRedisHashValues(serial(latest)));

      try {
        await multi.exec();
      } catch (err) {
        // We didn't manage to apply any changes
        // to this blog, so empty the list of changes
        return callback(err, []);
      }

      const template = latest.template || former.template;

        // Also update CDN manifest when plugin settings change, since
        // plugin changes (especially analytics) affect the rendered output
        // of views like script.js that use {{{appJS}}}
        const shouldUpdateManifest = changes.template || changes.plugins;

        if (template && shouldUpdateManifest) {
          try {
            await updateCdnManifestAsync(template);
          } catch (updateError) {
            // for now, do nothing
            console.log('Blog.set', blogID, 'Error updating template CDN manifest', updateError);
          }
        }

        if (former.handle && latest.handle) {
          var usesGit = former.client === "git" || latest.client === "git";

          if (usesGit) {
            try {
              await renameGitRepo(former.handle, latest.handle);
            } catch (renameError) {
              return callback(renameError);
            }
          }
        }

      flushCache(blogID, former, function (err) {
        callback(err, changesList);
      });
    });
  });
};
