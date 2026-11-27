var pathNormalizer = require("helper/pathNormalizer");

module.exports = {
  metadata: function metadata(name) {
    return "template:" + name + ":info";
  },

  view: function view(name, viewName) {
    return "template:" + name + ":view:" + viewName;
  },

  urlPatterns: function urlPatterns(name) {
    return "template:" + name + ":url_patterns";
  },

  url: function url(templateID, url) {
    return "template:" + templateID + ":url:" + url;
  },

  share: function (shareID) {
    return "template:share:" + shareID;
  },

  allViews: function allViews(name) {
    return "template:" + name + ":all_views";
  },

  // A HASH of view name to the fingerprint of the folder file the view was
  // last read from (readFromFolder), so a build can skip files which haven't
  // changed. Cleared for a view whenever it is saved or dropped otherwise.
  viewSources: function viewSources(name) {
    return "template:" + name + ":view_sources";
  },

  // Set while readFromFolder updates the template's CDN manifest, so a failed
  // update is retried by the next build even if nothing else changed
  manifestPending: function manifestPending(name) {
    return "template:" + name + ":manifest_pending";
  },

  blogTemplates: function blogTemplates(blogID) {
    return "template:owned_by:" + blogID;
  },

  // Per-blog state for detecting renamed local template folders
  folderPendingRemoval: function folderPendingRemoval(blogID) {
    return "template:folder_pending_removal:" + blogID;
  },

  folderFresh: function folderFresh(blogID) {
    return "template:folder_fresh:" + blogID;
  },

  // Set by sync when a path in the blog's templates folder was updated, and
  // cleared once buildFromFolder has read every template without a failure, so
  // a failed read is retried by the next sync
  needsBuild: function needsBuild(blogID) {
    return "template:needs_build:" + blogID;
  },

  renderedOutput: function renderedOutput(hash) {
    return "cdn:rendered:" + hash;
  },

  // Reverse index of the files in a blog's folder that templates link to
  // through {{#cdn}} (see util/updateCdnManifest): a SET of the IDs of the
  // blog's templates whose CDN manifest depends on the file, read by
  // sync/update/rebuildDependents so a changed file regenerates the manifest.
  // The path is lowercased on write and read because the manifest resolves
  // links case-insensitively (/Images/A.PNG finds /images/a.png) - unlike
  // entry dependents, where the folder's own spelling is used.
  templateDependents: function templateDependents(blogID, path) {
    return (
      "blog:" +
      blogID +
      ":template_dependents:" +
      pathNormalizer(path).toLowerCase()
    );
  },

  // Templates whose CDN manifest must be regenerated because a file they
  // link to changed during a sync. rebuildDependents adds to it for every
  // synced file; sync/index.js drains it once, at the end of the sync. A
  // Redis set rather than memory so that a sync which dies part way leaves
  // them for the next one.
  templateManifestsPending: function templateManifestsPending(blogID) {
    return "blog:" + blogID + ":template_manifests_pending";
  },
};
