const post = require("./post");

module.exports = {
  add: post.add,
  setShowText: post.setShowText,
  get: post.get,
  has: post.has,
  remove: post.remove,
  removeBlog: post.removeBlog,
  list: require("./list"),
  cards: require("./list").cards,
  photos: require("./photos"),
  profile: require("./profile"),
  postID: require("./postID"),
  token: require("./token"),
  key: require("./key"),
};
