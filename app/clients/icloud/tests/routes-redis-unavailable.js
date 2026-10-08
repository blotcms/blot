describe("iCloud macserver routes when Redis is unavailable", function () {
  // The macserver treats any reply that is not 2xx as a failed push, retries
  // it a few times, and then asks for a resync. So what matters is that a
  // route which could not update the database answers with an error AND
  // leaves the blog folder looking unchanged, otherwise the retry finds the
  // change already on disk and does nothing.
  const fs = require("fs-extra");
  const Entry = require("models/entry");
  const redis = require("models/client");
  const { SimpleError } = require("redis");
  const upload = require("../routes/site/upload");
  const remove = require("../routes/site/delete");
  const mkdir = require("../routes/site/mkdir");

  global.test.timeout(30 * 1000);
  global.test.blog();

  function freeze() {
    return new SimpleError("NOREPLICAS Not enough good replicas to write.");
  }

  function request(blogID, path, body) {
    const headers = {
      blogID,
      pathBase64: Buffer.from(path).toString("base64"),
      modifiedTime: new Date().toISOString(),
    };
    return { header: (name) => headers[name], body };
  }

  function response() {
    const res = {
      headersSent: false,
      headers: {},
      code: null,
      set(name, value) {
        res.headers[name] = value;
        return res;
      },
      status(code) {
        res.code = code;
        return res;
      },
      send() {
        res.headersSent = true;
        return res;
      },
      sendStatus(code) {
        res.code = code;
        res.headersSent = true;
        return res;
      },
    };
    return res;
  }

  async function call(route, blogID, path, body) {
    const res = response();
    await route(request(blogID, path, body), res);
    return res;
  }

  const getEntry = (blogID, path) =>
    new Promise((resolve) => Entry.get(blogID, path, resolve));

  beforeEach(function () {
    spyOn(console, "warn");
    this.onDisk = (path) => this.blogDirectory + path;
  });

  describe("upload", function () {
    it("refuses, leaves no file behind, and builds the entry on the retry", async function () {
      const path = "/hello.txt";
      const blogID = this.blog.id;

      spyOn(Entry, "set").and.callFake((id, p, entry, callback) =>
        callback(freeze())
      );

      for (const attempt of [1, 2]) {
        const res = await call(upload, blogID, path, Buffer.from("Hello"));
        expect(res.code).toBe(503);
        expect(res.headers["Retry-After"]).toBeTruthy();
        expect(await fs.pathExists(this.onDisk(path))).toBe(false);
      }

      Entry.set.and.callThrough();

      const res = await call(upload, blogID, path, Buffer.from("Hello"));
      expect(res.code).toBe(200);
      expect((await getEntry(blogID, path)).html).toContain("Hello");
    });

    it("notices an edit that leaves the file the same size", async function () {
      const path = "/edit.txt";
      const blogID = this.blog.id;

      expect((await call(upload, blogID, path, Buffer.from("aaaa"))).code).toBe(200);

      spyOn(Entry, "set").and.callFake((id, p, entry, callback) =>
        callback(freeze())
      );

      expect((await call(upload, blogID, path, Buffer.from("aaab"))).code).toBe(503);

      // Same size as the version in the database, but no longer on disk, so
      // neither the retry nor a resync mistakes it for up to date
      expect(await fs.pathExists(this.onDisk(path))).toBe(false);

      Entry.set.and.callThrough();

      expect((await call(upload, blogID, path, Buffer.from("aaab"))).code).toBe(200);
      expect((await getEntry(blogID, path)).html).toContain("aaab");
    });

    it("still answers 200 when update fails for another reason", async function () {
      const path = "/broken.txt";

      spyOn(console, "error");
      spyOn(Entry, "set").and.callFake((id, p, entry, callback) =>
        callback(new Error("this file is broken"))
      );

      const res = await call(upload, this.blog.id, path, Buffer.from("Hello"));
      expect(res.code).toBe(200);
      expect(await fs.pathExists(this.onDisk(path))).toBe(true);
    });
  });

  describe("delete", function () {
    it("refuses and puts the file back, then drops the entry on the retry", async function () {
      const path = "/gone.txt";
      const blogID = this.blog.id;

      expect((await call(upload, blogID, path, Buffer.from("Bye"))).code).toBe(200);

      spyOn(Entry, "drop").and.callFake((id, p, callback) => callback(freeze()));

      const res = await call(remove, blogID, path);
      expect(res.code).toBe(503);
      expect(await fs.readFile(this.onDisk(path), "utf-8")).toEqual("Bye");
      expect((await getEntry(blogID, path)).deleted).toBeFalsy();

      Entry.drop.and.callThrough();

      expect((await call(remove, blogID, path)).code).toBe(200);
      expect(await fs.pathExists(this.onDisk(path))).toBe(false);
      expect((await getEntry(blogID, path)).deleted).toBe(true);
    });

    it("restores a whole folder", async function () {
      const blogID = this.blog.id;

      await call(upload, blogID, "/folder/a.txt", Buffer.from("A"));
      await call(upload, blogID, "/folder/b.txt", Buffer.from("B"));

      spyOn(Entry, "drop").and.callFake((id, p, callback) => callback(freeze()));

      expect((await call(remove, blogID, "/folder")).code).toBe(503);
      expect(await fs.readFile(this.onDisk("/folder/a.txt"), "utf-8")).toEqual("A");
      expect(await fs.readFile(this.onDisk("/folder/b.txt"), "utf-8")).toEqual("B");
    });

    it("does not put the file back when update fails for another reason", async function () {
      const path = "/gone.txt";
      const blogID = this.blog.id;

      await call(upload, blogID, path, Buffer.from("Bye"));

      spyOn(console, "error");
      spyOn(Entry, "drop").and.callFake((id, p, callback) =>
        callback(new Error("this file is broken"))
      );

      expect((await call(remove, blogID, path)).code).toBe(200);
      expect(await fs.pathExists(this.onDisk(path))).toBe(false);
    });
  });

  describe("mkdir", function () {
    it("refuses and removes the directory, then creates it on the retry", async function () {
      const path = "/album+";
      const blogID = this.blog.id;

      // A "+" folder is the only directory update does any database work for
      spyOn(redis, "mGet").and.callFake(() => Promise.reject(freeze()));

      const res = await call(mkdir, blogID, path);
      expect(res.code).toBe(503);
      expect(await fs.pathExists(this.onDisk(path))).toBe(false);

      redis.mGet.and.callThrough();

      expect((await call(mkdir, blogID, path)).code).toBe(200);
      expect(await fs.pathExists(this.onDisk(path))).toBe(true);
    });
  });
});
