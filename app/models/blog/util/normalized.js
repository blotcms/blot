// The blogs Blog.get has already run through imageExif.apply and
// converters.apply, so Blog.extend doesn't do it again. Blogs from anywhere
// else (Blog.create, a hand-built object) aren't in it and are still
// normalized by extend. Weak, so a blog is forgotten once nothing holds it.
module.exports = new WeakSet();
