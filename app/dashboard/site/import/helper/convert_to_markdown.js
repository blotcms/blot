var htmlAssets = require("./html_assets");

// The conversion (turndown, with the options the importers need: no escaping,
// GFM, audio, video and iframes kept) runs in the sandbox's parse-html job, in
// app/sandbox/jobs/html.js
module.exports = function (post, callback) {
  if (post.html && post.content === undefined) {
    return htmlAssets.markdown(post.html).then(function (content) {
      post.content = content;
      callback(null, post);
    }, callback);
  }

  return callback(null, post);
};
