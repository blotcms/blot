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
var rebuildEntriesOnNewHosts = require("./rebuildEntriesOnNewHosts");
var normalizeImageExif = require("./util/imageExif").normalize;
var normalizeConverters = require("./util/converters").normalize;
var updateCdnManifest = require("../template/util/updateCdnManifest");
var forkSiteTemplate = require("../template/util/forkSiteTemplate");
var serializeRedisHashValues = require("models/redisHashSerializer");
var withCallback = require("helper/withCallback");

function Changes(latest, former) {
  var changes = {};

  // Determine any changes to the user's info
  for (var i in latest)
    if (!_.isEqual(latest[i], former[i])) changes[i] = latest[i];

  return changes;
}

// Resolves to the list of changed fields. Rejects with validate's errors
// object, or with the error that stopped the save.
module.exports = withCallback(async function set(blogID, blog) {
  ensure(blogID, "string");

  var multi = client.multi();
  var formerBackupDomain, changes, backupDomain;
  var changesList;

  var latest = await validate(blogID, blog);
  var former = (await get({ id: blogID })) || {};

  // Blog.get has already normalised former's imageExif and converters
  if (Object.prototype.hasOwnProperty.call(latest, "imageExif")) {
    latest.imageExif = normalizeImageExif(latest.imageExif, {
      fallback: former.imageExif || "off",
    });
  }

  if (Object.prototype.hasOwnProperty.call(latest, "converters")) {
    latest.converters = normalizeConverters(latest.converters, {
      fallback: former.converters,
    });
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
      console.log("Blog.set", blogID, "Error forking template", forkError);
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
  var domainChanged = Object.prototype.hasOwnProperty.call(changes, "domain");

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

  // Check if we need to bust the blog's caches
  // We sometimes manually pass in a new cache ID when we want
  // to bust the cache, e.g. in ./flushCache. A new handle or domain
  // changes which links the blog's own template views wrap in {{#cdn}}
  // (models/template/getFullView, cached per cacheID).
  if (
    changes.template ||
    changes.plugins ||
    changes.cacheID ||
    changes.menu ||
    changes.handle ||
    domainChanged
  ) {
    const now = Date.now();
    const previousCacheID = Number(former.cacheID) || 0;
    latest.cacheID = Math.max(now, previousCacheID + 1);
    changes.cacheID = true;
  }

  // Verify that all the new info matches
  // strictly the type specification
  ensure(latest, TYPE);

  changesList = _.keys(changes);

  // There are no changes to save so finish now
  if (!changesList.length) {
    return changesList;
  }

  multi.hSet(key.info(blogID), serializeRedisHashValues(serial(latest)));

  // If this fails, none of the changes were applied
  await multi.exec();

  const template = latest.template || former.template;

  // Also update CDN manifest when plugin settings change, since
  // plugin changes (especially analytics) affect the rendered output
  // of views like script.js that use {{{app_js}}}
  const shouldUpdateManifest = changes.template || changes.plugins;

  if (template && shouldUpdateManifest) {
    try {
      await updateCdnManifest(template);
    } catch (updateError) {
      // for now, do nothing
      console.log(
        "Blog.set",
        blogID,
        "Error updating template CDN manifest",
        updateError
      );
    }
  }

  await flushCache(blogID, former);

  // Entries link to the blog's own hosts (see folderAssets), so a new
  // handle or domain means some stored HTML needs baking again. This
  // runs in the background, after the caller has its answer: the
  // bridge calls back in a microtask, which runs before setImmediate.
  if (changes.handle || domainChanged) {
    setImmediate(function () {
      rebuildEntriesOnNewHosts(blogID, former);

      // Template views wrap links to the blog's own hosts in {{#cdn}}
      // when they render, so the CDN manifest must resolve the new
      // hosts' links too. Only the installed template has a manifest
      // (updateCdnManifest keeps the others empty). A blog being created
      // has no former handle and nothing to re-resolve, like
      // rebuildEntriesOnNewHosts; regenerating anyway raced with a
      // quick Blog.remove and recreated the template's metadata.
      if (former.handle && template && template.indexOf(blogID + ":") === 0)
        updateCdnManifest(template).catch(function (manifestErr) {
          console.log(
            "Blog.set",
            blogID,
            "Error updating template CDN manifest",
            manifestErr
          );
        });
    });
  }

  return changesList;
});
