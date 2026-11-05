const fs = require("fs-extra");
const build = require("build");
const set = require("../set");

// Entry.set tells its caller whether it changed anything a render reads, so a
// sync which rebuilds unchanged files can skip purging the blog's pages
describe("entry.set changed", function () {
  require("./setup")();

  beforeEach(function () {
    this.buildAndSet = (path, contents) =>
      new Promise((resolve, reject) => {
        fs.outputFileSync(this.blogDirectory + path, contents);
        build(this.blog, path, (err, entry) => {
          if (err) return reject(err);
          set(this.blog.id, path, entry, (err, result) => {
            if (err) return reject(err);
            resolve(result);
          });
        });
      });
  });

  it("reports a new entry as changed", async function () {
    expect(await this.buildAndSet("/a.txt", "Hello")).toEqual({ changed: true });
  });

  it("reports the same build again as unchanged", async function () {
    await this.buildAndSet("/a.txt", "Hello");
    expect(await this.buildAndSet("/a.txt", "Hello")).toEqual({ changed: false });
  });

  it("reports new contents as changed", async function () {
    await this.buildAndSet("/a.txt", "Hello");
    expect(await this.buildAndSet("/a.txt", "Hello, world")).toEqual({
      changed: true,
    });
  });

  // "Cats" and "cats" share one tag, whose display name the last entry saved
  // sets, so re-saving an unchanged entry can rename it on the other
  it("reports renaming a shared tag as changed", async function () {
    await this.buildAndSet("/a.txt", "Tags: Cats\n\nHello");
    await this.buildAndSet("/b.txt", "Tags: cats\n\nHello");

    expect(await this.buildAndSet("/a.txt", "Tags: Cats\n\nHello")).toEqual({
      changed: true,
    });
    expect(await this.buildAndSet("/a.txt", "Tags: Cats\n\nHello")).toEqual({
      changed: false,
    });
  });

  // The linked entry's backlinks change, though this entry's JSON may not
  it("reports a change to another entry's backlinks as changed", async function () {
    await this.buildAndSet("/linked.txt", "Link: linked\nLinked");
    await this.buildAndSet("/a.txt", "Hello");

    // The link is new, so linked.txt gains a backlink
    expect(
      await this.buildAndSet("/a.txt", 'Hello <a href="/linked">there</a>')
    ).toEqual({ changed: true });

    expect(
      await this.buildAndSet("/a.txt", 'Hello <a href="/linked">there</a>')
    ).toEqual({ changed: false });
  });
});
