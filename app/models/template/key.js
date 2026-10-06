module.exports = {
  metadata: function metadata (name) {
    return "template:" + name + ":info";
  },

  view: function view (name, viewName) {
    return "template:" + name + ":view:" + viewName;
  },

  urlPatterns: function urlPatterns (name) {
    return "template:" + name + ":url_patterns";
  },
  
  url: function url (templateID, url) {
    return "template:" + templateID + ":url:" + url;
  },

  share: function (shareID) {
    return "template:share:" + shareID;
  },

  allViews: function allViews (name) {
    return "template:" + name + ":all_views";
  },

  blogTemplates: function blogTemplates (blogID) {
    return "template:owned_by:" + blogID;
  },

  // Per-blog state for detecting renamed local template folders
  folderPendingRemoval: function folderPendingRemoval (blogID) {
    return "template:folder_pending_removal:" + blogID;
  },

  folderFresh: function folderFresh (blogID) {
    return "template:folder_fresh:" + blogID;
  },

  renderedOutput: function renderedOutput(hash) {
    return "cdn:rendered:" + hash;
  }
};
