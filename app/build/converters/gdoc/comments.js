// Comments are private to a Doc's editors. Google's export marks each
// commented passage with a numbered link, <sup><a id="cmnt_ref1">[a]</a></sup>,
// and puts each comment, with its replies, in its own <div> at the end, its
// first paragraph starting <a id="cmnt1">[a]</a>. This removes both, so no
// comment reaches the blog folder (clients/google-drive/util/download.js) or
// a post (./index.js, for files exported before).
const MARKER = /^cmnt_ref\d+$/;
const COMMENT = /^cmnt\d+$/;

module.exports = function removeComments($) {
  $("a[id]")
    .filter((i, el) => MARKER.test($(el).attr("id")))
    .each(function () {
      const sup = $(this).parent("sup");
      (sup.length ? sup : $(this)).remove();
    });

  $("a[id]")
    .filter((i, el) => COMMENT.test($(el).attr("id")))
    .each(function () {
      const box = $(this).closest("div");
      (box.length ? box : $(this).closest("p")).remove();
    });
};
