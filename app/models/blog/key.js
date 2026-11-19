module.exports = {
  // String which stores the blog ID for a handle/username
  // method accepts the handle of a blog as a String
  handle: function (handle) {
    return "handle:" + handle;
  },

  // Hash which stores the blog's data, one field per property, with object
  // and array properties JSON-encoded (see serial.js)
  // method accepts the ID of a blog as a String
  info: function (blogID) {
    return "blog:" + blogID + ":info";
  },

  // List which stores JSON object including status updates for
  // syncs which take place for the blog.
  status: function (blogID) {
    return "blog:" + blogID + ":status";
  },

  // String which stores the blog ID for a domain
  // method accepts the custom domain for a blog as a String
  domain: function (domain) {
    return "domain:" + domain;
  },

  // Integer which indicates the number of blogs that ever were
  totalBlogs: "total:blogs",

  // Set which stores all the IDs of extant blogs
  ids: "blogs",
};
