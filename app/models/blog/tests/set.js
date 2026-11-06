describe("Blog.set", function () {
  var set = require("../set");
  var get = require("../get");
  var key = require("../key");
  var client = require("models/client");
  var config = require("config");

  global.test.blog();

  it("resolves to the changed fields without a callback", async function () {
    const title = "Promise title " + Date.now();

    expect(await set(this.blog.id, { title })).toEqual(["title"]);
    expect(await set(this.blog.id, { title })).toEqual([]);
    expect((await get({ id: this.blog.id })).title).toBe(title);
  });

  it("rejects with the validation errors without a callback", async function () {
    const errors = await set(this.blog.id, { handle: "a" }).catch((e) => e);

    expect(errors.handle).toBeTruthy();
  });

  it("calls back with the changed fields", function (done) {
    set(this.blog.id, { title: "Callback title" }, function (err, changes) {
      if (err) return done.fail(err);
      expect(changes).toEqual(["title"]);
      done();
    });
  });

  it("will set the domain", async function () {
    var domain = "example.com";

    await set(this.blog.id, { domain: domain });
  });

  it("disables image metadata when turned off", async function () {
    await set(this.blog.id, { imageExif: "off" });

    const blog = await get({ id: this.blog.id });

    expect(blog.imageExif).toBe("off");
    expect(blog.isImageExifOff).toBe(true);
    expect(blog.isImageExifBasic).toBe(false);
  });

  it("saves full image metadata preference", async function () {
    await set(this.blog.id, { imageExif: "full" });

    const blog = await get({ id: this.blog.id });

    expect(blog.imageExif).toBe("full");
    expect(blog.isImageExifFull).toBe(true);
    expect(blog.isImageExifOff).toBe(false);
  });

  it("normalizes converter preferences", async function () {
    await set(this.blog.id, {
      converters: { img: false, markdown: "true", unknown: false },
    });

    const blog = await get({ id: this.blog.id });

    expect(blog.converters.img).toBe(false);
    expect(blog.converters.markdown).toBe(true);
    expect(blog.converters.docx).toBe(true);
    expect(blog.converters.unknown).toBe(undefined);
  });

  it("updates the handle host without touching custom domains", async function () {
    var originalHandle = this.blog.handle;
    var newHandle = originalHandle + "new";
    var oldHostKey = key.domain(originalHandle + "." + config.host);
    var newHostKey = key.domain(newHandle + "." + config.host);
    var preservedKey = key.domain("keep." + config.host);
    var customDomain = "custom-domain.test";
    var customDomainKey = key.domain(customDomain);

    await client.set(preservedKey, "keep");

    await set(this.blog.id, { domain: customDomain });

    const valuesBefore = await client.mGet([oldHostKey, customDomainKey]);
    expect(valuesBefore[0]).toBe(this.blog.id);
    expect(valuesBefore[1]).toBe(this.blog.id);

    await set(this.blog.id, { handle: newHandle });

    const values = await client.mGet([
      oldHostKey,
      preservedKey,
      newHostKey,
      customDomainKey,
    ]);
    expect(values[0]).toBe(null);
    expect(values[1]).toBe("keep");
    expect(values[2]).toBe(this.blog.id);
    expect(values[3]).toBe(this.blog.id);
  });

  it("updates the cacheID when the menu changes", async function () {
    const before = await get({ id: this.blog.id });

    var updatedMenu = before.menu.map(function (item, index) {
      if (index === 0) {
        return Object.assign({}, item, {
          label: item.label + " Updated",
        });
      }

      return item;
    });

    var originalCacheID = before.cacheID;

    await set(this.blog.id, { menu: updatedMenu });

    const after = await get({ id: this.blog.id });

    expect(after.menu[0].label).toBe(updatedMenu[0].label);
    expect(after.cacheID).toBeGreaterThan(originalCacheID);
  });

  it("increments cacheID monotonically when Date.now() would not advance", async function () {
    var frozenNow = 1000000000000;

    const before = await get({ id: this.blog.id });

    var originalCacheID = Number(before.cacheID) || 0;
    var dateNow = Date.now;

    var menuWithChange = before.menu.map(function (item, index) {
      return index === 0
        ? Object.assign({}, item, { label: item.label + " X" })
        : item;
    });

    Date.now = function () {
      return frozenNow;
    };

    try {
      await set(this.blog.id, { menu: menuWithChange });
    } finally {
      Date.now = dateNow;
    }

    const after = await get({ id: this.blog.id });

    expect(after.cacheID).toBeGreaterThan(originalCacheID);
    expect(after.cacheID).toBeGreaterThanOrEqual(frozenNow);
  });
});
