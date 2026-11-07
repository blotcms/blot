var htmlAssets = require("./html_assets");

// The conversion (turndown, with the options the importers need: no escaping,
// GFM, audio, video and iframes kept) runs in the sandbox's parse-html job, in
// app/sandbox/jobs/html.js
module.exports = async function (post) {
  if (post.html && post.content === undefined) {
    post.content = await htmlAssets.markdown(post.html);
  }

  return post;
};
