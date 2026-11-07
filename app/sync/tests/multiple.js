describe("multiple blogs", function () {
  var sync = require("../index");

  // Set up array of 20 test blogs before each test
  // and remove them afterwards
  global.test.blogs(20);

  // Locks held by a dead process expire after their TTL (10s) instead of
  // being freed by the OS, so retry until each one can be acquired.
  async function syncWhenFree(blogID) {
    var deadline = Date.now() + 25 * 1000;

    for (;;) {
      try {
        return await sync(blogID, async function () {});
      } catch (err) {
        if (Date.now() >= deadline) throw err;
        await new Promise(function (resolve) {
          setTimeout(resolve, 1000);
        });
      }
    }
  }

  it(
    "locks are freed when process dies",
    function (testDone) {
      var child = require("child_process").fork(__dirname + "/kill");
      var responses = 0;
      var blogs = this.blogs;

      blogs.forEach(function (blog) {
        child.send(blog.id);
      });

      // Find out if the child managed to acquire a lock on this blog
      child.on("message", function (message) {
        if (message.error) {
          testDone.fail(message.error);
        } else {
          ++responses;
          if (responses === blogs.length) child.kill();
        }
      });

      // Did sync release the child's lock on the blog when the child
      // died (was killed)? We test this by trying to acquire a lock.
      child.on("close", async function () {
        try {
          for (const blog of blogs) await syncWhenFree(blog.id);
        } catch (err) {
          return testDone.fail(err);
        }

        testDone();
      });
    },
    60 * 1000
  );
});
