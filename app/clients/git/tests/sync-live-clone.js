// IMPLEMENTATION-SPECIFIC. This file tests the live clone: the second copy of
// the repository which the git client keeps in the blog folder's .git
// directory and runs `fetch` and `reset --hard` in. It is not behaviour a
// user can see, so it does not belong with the specs that must survive the
// rewrite of the git client (https://github.com/blotcms/blot/issues/2259).
//
// Delete this file when the live clone goes away: the blog folder is then
// materialized straight from the repository, and has no .git directory whose
// absence could be an error.
describe("git client sync (implementation-specific: needs the live clone)", function () {
  require("./setup")({ clone: false });

  var fs = require("fs-extra");
  var sync = require("clients/git/sync");

  it("should return an error if there is no git repo in blog folder", function (done) {
    fs.removeSync(this.blogDirectory + "/.git");

    sync(this.blog.id, this.blog.handle, function (err) {
      expect(err.message).toContain("not");
      done();
    });
  });
});
