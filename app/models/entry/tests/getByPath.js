describe("entry.getByPath", function () {
  require("./setup")();

  var getByPath = require("../getByPath");

  var lookup = function (blogID, path) {
    return new Promise(function (resolve) {
      getByPath(blogID, path, function (entry) {
        resolve(entry);
      });
    });
  };

  it("returns the entry when the path matches exactly", async function () {
    await this.set("/Pages/Home.txt", "Hello from home");

    var entry = await lookup(this.blog.id, "/Pages/Home.txt");

    expect(entry).toBeTruthy();
    expect(entry.path).toEqual("/Pages/Home.txt");
  });

  it("resolves a differently-cased path to its canonical entry", async function () {
    await this.set("/Pages/Home.txt", "Hello from home");

    var entry = await lookup(this.blog.id, "/pages/home.txt");

    expect(entry).toBeTruthy();
    expect(entry.path).toEqual("/Pages/Home.txt");
  });

  it("returns nothing when no entry matches case-insensitively", async function () {
    await this.set("/Pages/Home.txt", "Hello from home");

    var entry = await lookup(this.blog.id, "/pages/missing.txt");

    expect(entry).toBeUndefined();
  });

  it("prefers a live entry over a same-path tombstone left by a case rename", async function () {
    await this.set("/pages/home.txt", "Old lower-case entry");
    await this.drop("/pages/home.txt");
    await this.set("/Pages/Home.txt", "New true-case entry");

    var entry = await lookup(this.blog.id, "/pages/home.txt");

    expect(entry).toBeTruthy();
    expect(entry.path).toEqual("/Pages/Home.txt");
    expect(entry.deleted).toEqual(false);
  });

  it("falls back to the exact-case entry when it is the only match", async function () {
    await this.set("/pages/home.txt", "Only entry");
    await this.drop("/pages/home.txt");

    var entry = await lookup(this.blog.id, "/pages/home.txt");

    expect(entry).toBeTruthy();
    expect(entry.path).toEqual("/pages/home.txt");
    expect(entry.deleted).toEqual(true);
  });
});
