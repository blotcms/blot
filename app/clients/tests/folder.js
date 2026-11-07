const fs = require("fs-extra");
const os = require("os");
const { join } = require("path");
const folder = require("storage/folder");
const { promisify } = require("util");
const clients = require("clients");
const blogFolder = require("../folder");
const Blog = require("models/blog");

describe("clients/folder", function () {
  global.test.blog();

  const setClient = promisify((blogID, client, cb) =>
    Blog.set(blogID, { client }, cb)
  );

  afterEach(function () {
    delete clients.routerSpecClient;
  });

  function stubClient() {
    const client = {
      write: jasmine.createSpy("write").and.callFake(async () => {}),
      remove: jasmine.createSpy("remove").and.callFake(async () => {}),
    };
    clients.routerSpecClient = client;
    return client;
  }

  describe("a blog with no client", function () {
    it("writes and removes in the blog folder", async function () {
      await blogFolder.write(this.blog.id, "/a.txt", "hello");
      expect(await test.folder.readText(this.blog.id, "/a.txt")).toBe("hello");

      await blogFolder.remove(this.blog.id, "/a.txt");
      expect(await folder.exists(this.blog.id, "/a.txt")).toBe(false);
    });

    it("copies a file in with writeFrom", async function () {
      const source = join(os.tmpdir(), "router-source-" + Date.now());
      fs.outputFileSync(source, "from disk");

      try {
        await blogFolder.writeFrom(this.blog, "/b/c.txt", source);
        expect(await test.folder.readText(this.blog.id, "/b/c.txt")).toBe(
          "from disk"
        );
      } finally {
        fs.removeSync(source);
      }
    });

    it("treats a client name that is not available as no client", async function () {
      await setClient(this.blog.id, "not-a-client");
      await blogFolder.write(this.blog.id, "/d.txt", "still local");
      expect(await test.folder.readText(this.blog.id, "/d.txt")).toBe(
        "still local"
      );
    });
  });

  describe("a blog with a client", function () {
    it("hands writes and removes to the client, not the folder", async function () {
      const client = stubClient();
      await setClient(this.blog.id, "routerSpecClient");

      await blogFolder.write(this.blog.id, "/e.txt", "via client");
      expect(client.write).toHaveBeenCalledTimes(1);
      expect(client.write.calls.argsFor(0).slice(0, 3)).toEqual([
        this.blog.id,
        "/e.txt",
        "via client",
      ]);
      expect(await folder.exists(this.blog.id, "/e.txt")).toBe(false);

      await blogFolder.remove(this.blog.id, "/e.txt");
      expect(client.remove).toHaveBeenCalledTimes(1);
      expect(client.remove.calls.argsFor(0).slice(0, 2)).toEqual([
        this.blog.id,
        "/e.txt",
      ]);
    });

    it("reads a file into a Buffer for the client with writeFrom", async function () {
      const client = stubClient();
      const blog = Object.assign({}, this.blog, { client: "routerSpecClient" });
      const source = join(os.tmpdir(), "router-source-" + Date.now());
      fs.outputFileSync(source, "buffered");

      try {
        await blogFolder.writeFrom(blog, "f.txt", source);
      } finally {
        fs.removeSync(source);
      }

      const args = client.write.calls.argsFor(0);
      expect(args[0]).toBe(this.blog.id);
      expect(args[1]).toBe("f.txt");
      expect(Buffer.isBuffer(args[2])).toBe(true);
      expect(args[2].toString()).toBe("buffered");
      expect(await folder.exists(this.blog.id, "/f.txt")).toBe(false);
    });

    it("rejects with the client's error", async function () {
      const client = stubClient();
      client.write.and.callFake(async () => {
        throw new Error("client failed");
      });
      await setClient(this.blog.id, "routerSpecClient");

      let error;

      try {
        await blogFolder.write(this.blog.id, "/g.txt", "x");
      } catch (err) {
        error = err;
      }

      expect(error && error.message).toBe("client failed");
    });
  });
});
