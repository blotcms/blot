const ensure = require("helper/ensure");

// Discover is one list for the whole of blot.im, not data of any one blog,
// so these keys are not under blog:{blogID}.
module.exports = {
  // Sorted set of post IDs, scored by when the maintainer added each post
  posts: function () {
    return "discover:posts";
  },

  // Hash: blogID, entryID, photos (JSON) and added
  post: function (postID) {
    ensure(postID, "string");
    return "discover:post:" + postID;
  },

  // Set of a blog's post IDs, so a blog's posts can be removed together
  blog: function (blogID) {
    ensure(blogID, "string");
    return "discover:blog:" + blogID;
  },

  // Hash: name, bio and avatar (an asset path) shown in place of the site's
  // own, set by the maintainer
  profile: function (blogID) {
    ensure(blogID, "string");
    return "discover:profile:" + blogID;
  },

  // String: the post reference an "Add to Discover" link is for
  token: function (token) {
    ensure(token, "string");
    return "discover:token:" + token;
  },
};
