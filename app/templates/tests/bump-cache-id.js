describe("templates bumpCacheIDForTemplateUsers", function () {
  const Blog = require("models/blog");
  const key = require("models/blog/key");
  const client = require("models/client");
  const { promisify } = require("util");
  const { bumpCacheIDForTemplateUsers } = require("templates");
  const bump = promisify(bumpCacheIDForTemplateUsers);
  const get = (id) => promisify(Blog.get)({ id });

  global.test.blogs(2);

  it("bumps only the blogs on the rebuilt template", async function () {
    const [onIt, other] = this.blogs;
    // Set directly: Blog.set would fork a SITE template into the blog's own.
    await client.hSet(key.info(onIt.id), { template: "SITE:blog", cacheID: "1" });
    await client.hSet(key.info(other.id), { template: "SITE:magazine", cacheID: "1" });

    await bump("SITE:blog");

    expect((await get(onIt.id)).cacheID).toBeGreaterThan(1);
    expect((await get(other.id)).cacheID).toBe(1);
  });
});
