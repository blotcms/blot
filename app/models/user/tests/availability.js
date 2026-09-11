const { promisify } = require("util");
const User = require("models/user");
const Blog = require("models/blog");
const client = require("models/client");
const userKey = require("../key");
const blogKey = require("models/blog/key");
const getUser = promisify(User.getById);
const getBlog = promisify(Blog.get);
const setUser = promisify(User.set);
const setBlog = promisify(Blog.set);

// Fail at the storage boundary once, allowing subsequent retries to use Redis.
// Cover both transactional and Lua commits used by the user model.
function failCommitOnce(target) {
  let failed = false;
  const multi = client.multi.bind(client);
  spyOn(client, "multi").and.callFake(function () {
    const transaction = multi();
    let touchesTarget = false;
    ["set", "hSet"].forEach(function (method) {
      const command = transaction[method].bind(transaction);
      transaction[method] = function (name, ...args) {
        if (name === target) touchesTarget = true;
        return command(name, ...args);
      };
    });
    const exec = transaction.exec.bind(transaction);
    transaction.exec = async function () {
      if (touchesTarget && !failed) {
        failed = true;
        throw new Error("Temporary write failure");
      }
      return exec();
    };
    return transaction;
  });
  const evaluate = client.eval.bind(client);
  spyOn(client, "eval").and.callFake(async function (script, options) {
    if (options.keys[0] === target && !failed) {
      failed = true;
      throw new Error("Temporary write failure");
    }
    return evaluate(script, options);
  });
}

describe("retryable account availability transitions", function () {
  global.test.blogs(2);

  ["enable", "disable"].forEach(function (operation) {
    const targetDisabled = operation === "disable";
    const transition = promisify(User[operation]);

    async function prepare(context) {
      await setUser(context.user.uid, {
        isDisabled: !targetDisabled,
        blogs: context.blogs.map(blog => blog.id),
      });
      for (const blog of context.blogs) {
        await setBlog(blog.id, { isDisabled: !targetDisabled });
      }
      return getUser(context.user.uid);
    }

    async function expectCompleted(context) {
      const saved = await getUser(context.user.uid);
      expect(saved.isDisabled).toBe(targetDisabled);
      expect(saved.lastSession).toBe("transition-complete");
      for (const blog of context.blogs) {
        expect((await getBlog({ id: blog.id })).isDisabled).toBe(targetDisabled);
      }
    }

    it(operation + " keeps the account eligible for retry after a blog write fails", async function () {
      const user = await prepare(this);
      failCommitOnce(blogKey.info(this.blogs[1].id));
      const error = await transition(user, { lastSession: "transition-complete" })
        .then(() => null, err => err);
      expect(error.message).toBe("Temporary write failure");
      const pending = await getUser(user.uid);
      expect(pending.isDisabled).toBe(!targetDisabled);
      expect(pending.lastSession).not.toBe("transition-complete");
      await transition(pending, { lastSession: "transition-complete" });
      await expectCompleted(this);
    });

    it(operation + " keeps the account eligible for retry after the final account write fails", async function () {
      const user = await prepare(this);
      failCommitOnce(userKey.user(user.uid));
      const error = await transition(user, { lastSession: "transition-complete" })
        .then(() => null, err => err);
      expect(error.message).toBe("Temporary write failure");
      const pending = await getUser(user.uid);
      expect(pending.isDisabled).toBe(!targetDisabled);
      for (const blog of this.blogs) {
        expect((await getBlog({ id: blog.id })).isDisabled).toBe(targetDisabled);
      }
      await transition(pending, { lastSession: "transition-complete" });
      await expectCompleted(this);
    });
  });
});
