describe("dashboard site save: replaced avatar", function () {
  global.test.blog();
  global.test.tmp();

  const fs = require("fs-extra");
  const { join } = require("path");
  const sharp = require("sharp");
  const Blog = require("models/blog");
  const assets = require("storage/assets");
  const save = require("../save");
  const savePhoto = require("../template/save/photo");

  const names = async (blogID) =>
    (await assets.list(blogID, "_avatars")).sort();

  async function upload(directory, name) {
    const path = join(directory, name);
    await sharp({
      create: { width: 20, height: 20, channels: 4, background: "#13579b" },
    })
      .png()
      .toFile(path);
    return { path, size: (await fs.stat(path)).size };
  }

  // Runs one middleware as Express would, resolving with what it passed to next
  const run = (middleware, req, res) =>
    new Promise((resolve) => {
      res.message = (redirect, message) => resolve({ message });
      res.redirect = (redirect) => resolve({ redirect });
      middleware(req, res, (err) => resolve({ err }));
    });

  async function request(test, file) {
    const blog = await Blog.get({ id: test.blog.id });
    return {
      req: {
        blog,
        body: { redirect: "/x" },
        files: { avatar: file },
        updates: {},
        baseUrl: "",
        path: "/",
      },
      res: { locals: { blog } },
    };
  }

  async function saveAvatar(test, file) {
    const { req, res } = await request(test, file);

    expect((await run(save.avatar, req, res)).err).toBeUndefined();

    return run(save.finish, req, res);
  }

  beforeEach(async function () {
    this.first = await upload(this.tmp, "first.png");
    this.second = await upload(this.tmp, "second.png");
    this.third = await upload(this.tmp, "third.png");
  });

  it("deletes the previous avatar and keeps the new one", async function () {
    await saveAvatar(this, this.first);
    const [firstName] = await names(this.blog.id);
    expect((await Blog.get({ id: this.blog.id })).avatar).toContain(firstName);

    await saveAvatar(this, this.second);
    const remaining = await names(this.blog.id);
    const blog = await Blog.get({ id: this.blog.id });

    expect(remaining.length).toBe(1);
    expect(remaining[0]).not.toBe(firstName);
    expect(blog.avatar).toContain(remaining[0]);
  });

  it("keeps the previous avatar when the save fails, and drops the new file", async function () {
    await saveAvatar(this, this.first);
    const before = await names(this.blog.id);
    const { req, res } = await request(this, this.second);

    expect((await run(save.avatar, req, res)).err).toBeUndefined();
    expect((await names(this.blog.id)).length).toBe(2);

    spyOn(Blog, "set").and.returnValue(Promise.reject(new Error("no")));

    expect((await run(save.finish, req, res)).err).toEqual(jasmine.any(Error));
    expect(await names(this.blog.id)).toEqual(before);
  });

  it("keeps the new file when a rejected save stored it anyway", async function () {
    await saveAvatar(this, this.first);
    const { req, res } = await request(this, this.second);

    expect((await run(save.avatar, req, res)).err).toBeUndefined();

    // Blog.set writes, then rejects (as when flushing caches fails after the
    // write)
    const set = Blog.set;
    spyOn(Blog, "set").and.callFake(async (id, updates) => {
      await set(id, updates);
      throw new Error("flush failed");
    });

    expect((await run(save.finish, req, res)).err).toEqual(jasmine.any(Error));

    const blog = await Blog.get({ id: this.blog.id });
    const kept = await names(this.blog.id);

    expect(kept.some((name) => blog.avatar.includes(name))).toBe(true);
  });

  it("deletes the previous avatar in the photo and favicon flow, and when the photo is removed", async function () {
    await saveAvatar(this, this.first);

    const blog = await Blog.get({ id: this.blog.id });
    const req = {
      blog,
      baseUrl: "/b",
      params: { templateSlug: "t" },
      body: {},
      files: { avatar: this.third },
      template: { locals: {} },
    };

    expect((await run(savePhoto, req, { locals: { blog } })).message).toBe(
      "Saved photo!"
    );
    expect((await names(this.blog.id)).length).toBe(1);

    const clear = {
      blog: await Blog.get({ id: this.blog.id }),
      baseUrl: "/b",
      params: { templateSlug: "t" },
      body: { avatar: "" },
      files: {},
      template: { locals: {} },
    };

    expect((await run(savePhoto, clear, { locals: {} })).message).toBe(
      "Removed photo!"
    );
    expect(await names(this.blog.id)).toEqual([]);
  });
});
