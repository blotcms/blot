const BLOT_CDN_TOKEN = require("./replaceFolderLinks/cdnToken");
const { folderUrl } = require("./replaceFolderLinks/folderFile");
const { pathPartOf, encodeFolderPath } = require("./replaceFolderLinks/shared");
const blogHosts = require("../lib/blogHosts");
const { mapFolderLocals } = require("models/template/util/resolveFolderLinks");

// The versioned CDN URL for a file in the blog's folder, from the template's
// CDN manifest (see models/template/util/updateCdnManifest), or null if the
// manifest has no folder entry for the target. `target` is the manifest key:
// the link without its leading slash, ?query and #hash included. No disk
// access: the manifest already holds each file's real path and version.
//
// The %%BLOT_CDN%% token is swapped for the real origin once the page has
// rendered (blog/render/middleware.js).
module.exports = function folderManifestUrl(req, target) {
  if (!req || req.preview || !req.template || !req.blog) return null;

  const manifest = req.template.cdn;

  if (!manifest || !Object.prototype.hasOwnProperty.call(manifest, target))
    return null;

  const entry = manifest[target];

  // A rendered view (a content hash), not a folder file
  if (!entry || typeof entry !== "object" || typeof entry.path !== "string")
    return null;

  // The entry's path is the file's real, case-corrected path, without any
  // ?query or #hash, which are kept from the link.
  const suffix = target.slice(pathPartOf(target).length);

  // Reserved global paths such as /fonts have no version
  if (!entry.version) return BLOT_CDN_TOKEN + encodeFolderPath(entry.path) + suffix;

  return folderUrl(req.blog.id, entry.path, entry.version, suffix);
};

// Template locals with folder-link values ("logo": "/images/logo.png"), with
// each value the manifest resolves swapped for its CDN URL. Returns a copy
// (or the same object if nothing changed): template locals are cached and
// shared between requests, so they're never modified in place.
module.exports.locals = function folderManifestLocals(req, locals) {
  if (!locals || typeof locals !== "object") return locals;
  if (!req || req.preview || !req.template || !req.blog) return locals;

  const manifest = req.template.cdn;

  if (!manifest || typeof manifest !== "object" || !Object.keys(manifest).length)
    return locals;

  return mapFolderLocals(locals, blogHosts(req.blog), (target) =>
    module.exports(req, target)
  );
};
