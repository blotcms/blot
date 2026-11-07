const build = require("build");
const set = require("../set");
const drop = require("../drop");
const setUrl = require("../_setUrl");

// Entry.set, Entry.drop and setUrl return a promise (#2559)
describe("entry.set and entry.drop promise form", function () {
  require("./setup")();

  beforeEach(function () {
    this.built = async (path, contents) => {
      await require("storage/folder").write(this.blog.id, path, contents);
      return build(this.blog, path);
    };
  });

  it("set resolves to { changed }", async function () {
    const entry = await this.built("/a.txt", "Hello");
    const result = await set(this.blog.id, "/a.txt", entry);

    expect(result).toEqual({ changed: true });
    expect((await this.get("/a.txt")).url).toEqual("/a");
  });

  it("set rejects for a blog that does not exist", async function () {
    const entry = await this.built("/a.txt", "Hello");
    let error;

    try {
      await set("blog_doesnotexist", "/a.txt", entry);
    } catch (e) {
      error = e;
    }

    expect(error instanceof Error).toBe(true);
  });

  it("setUrl resolves to the url", async function () {
    const entry = await this.built("/b.txt", "Hello");
    const result = await setUrl(this.blog.id, entry);

    expect(result.url).toEqual("/b");
    expect(result.conflictingEntryPath).toBe(null);
  });

  it("drop deletes the entry and resolves", async function () {
    const entry = await this.built("/c.txt", "Hello");
    await set(this.blog.id, "/c.txt", entry);

    await drop(this.blog.id, "/c.txt");

    expect((await this.get("/c.txt")).deleted).toBe(true);
  });

  it("drop resolves for an entry that does not exist", async function () {
    expect(await drop(this.blog.id, "/missing.txt")).toBe(undefined);
  });
});
