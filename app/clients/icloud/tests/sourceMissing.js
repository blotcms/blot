const database = require("clients/icloud/database");
const { BLOG_DIRECTORY_DELETED } = require("clients/icloud/error");

describe("iCloud write and remove while the folder is missing", function () {
  global.test.blog();

  let calls, write, remove, saved;
  const names = [
    "../sync/util/remoteUpload",
    "../sync/util/remoteDelete",
    "../write",
    "../remove",
  ].map((n) => require.resolve(n));

  beforeEach(function () {
    calls = [];
    saved = names.map((p) => require.cache[p]);
    require(names[0]);
    require(names[1]);
    require.cache[names[0]].exports = async (...a) => calls.push(["upload", ...a]);
    require.cache[names[1]].exports = async (...a) => calls.push(["delete", ...a]);
    delete require.cache[names[2]];
    delete require.cache[names[3]];
    write = require("../write");
    remove = require("../remove");
  });

  afterEach(async function () {
    names.forEach((p, i) => {
      if (saved[i]) require.cache[p] = saved[i];
      else delete require.cache[p];
    });
    await database.delete(this.blog.id);
  });

  const run = (fn, ...args) =>
    new Promise((resolve, reject) =>
      fn(...args, (e) => (e ? reject(e) : resolve()))
    );

  it("tells the macserver when the folder is present", async function () {
    await database.store(this.blog.id, { setupComplete: true, error: null });
    await run(write, this.blog.id, "/a.txt", "hi");
    await run(remove, this.blog.id, "/a.txt");
    expect(calls.map((c) => c[0])).toEqual(["upload", "delete"]);
  });

  it("writes and removes locally but skips the macserver when SOURCE_MISSING", async function () {
    await database.store(this.blog.id, {
      setupComplete: true,
      error: BLOG_DIRECTORY_DELETED,
    });
    await run(write, this.blog.id, "/a.txt", "hi");
    await run(remove, this.blog.id, "/a.txt");
    expect(calls).toEqual([]);
  });
});
