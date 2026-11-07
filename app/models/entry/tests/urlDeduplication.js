const folder = require("storage/folder");
const build = require("build");
const setUrl = require("../_setUrl");

describe("entry.urlDeduplication", function () {
  require("./setup")();

  it("setUrl returns conflictingEntryPath when first candidate conflicts", async function () {
    await this.set("/original.txt", "Link: conflict\nHello, original!");

    await folder.write(
      this.blog.id,
      "/conflict.txt",
      "Link: conflict\nHello, conflict!"
    );

    const builtEntry = await build(this.blog, "/conflict.txt");

    const result = await setUrl(this.blog.id, builtEntry);

    expect(result.url).toEqual("/conflict-2");
    expect(result.conflictingEntryPath).toEqual("/original.txt");
  });

  it("uses mixed-case permalink metadata as first url candidate", async function () {
    const entry = await this.set(
      "/mixed-permalink.txt",
      "Permalink: Mixed-Case-Path\nHello, mixed!"
    );

    expect(entry.url).toEqual("/mixed-case-path");
  });

  it("adds dependency when URL is deduplicated", async function () {
    await this.set("/dep-a.txt", "Link: dedup\nHello, dep A!");
    const deduplicated = await this.set(
      "/dep-b.txt",
      "Link: dedup\nHello, dep B!"
    );

    expect(deduplicated.url).toEqual("/dedup-2");
    expect(deduplicated.dependencies).toContain("/dep-a.txt");
  });

  it("removes dependency when entry reclaims original URL", async function () {
    await this.set("/reclaim-a.txt", "Link: reclaim\nHello, reclaim A!");

    const content = "Link: reclaim\nHello, reclaim B!";
    await this.set("/reclaim-b.txt", content);

    await this.remove("/reclaim-a.txt");

    const reclaimed = await this.set("/reclaim-b.txt", content);

    expect(reclaimed.url).toEqual("/reclaim");
    expect(reclaimed.dependencies).not.toContain("/reclaim-a.txt");
  });

  it("does not add dependency for multiple conflicts", async function () {
    await this.set("/multi-a.txt", "Link: multi\nHello, multi A!");
    await this.set("/multi-b.txt", "Link: multi\nHello, multi B!");

    const third = await this.set(
      "/multi-c.txt",
      "Link: multi\nHello, multi C!"
    );

    expect(third.url).toEqual("/multi-3");
    expect(third.dependencies).toContain("/multi-a.txt");
    expect(third.dependencies).not.toContain("/multi-b.txt");
  });

  it("publishes a folder post at its plus-stripped path", async function () {
    await folder.write(this.blog.id, "/album+/one.md", "Link: /album\n\n# One");

    const builtEntry = await build(this.blog, "/album+/one.md");

    expect(builtEntry.path).toEqual("/album");

    const result = await setUrl(this.blog.id, builtEntry);

    expect(result.url).toEqual("/album");
  });

  it("returns null conflictingEntryPath when no conflict", async function () {
    await folder.write(
      this.blog.id,
      "/unique.txt",
      "Link: unique\nHello, unique!"
    );

    const builtEntry = await build(this.blog, "/unique.txt");

    const result = await setUrl(this.blog.id, builtEntry);

    expect(result.url).toEqual("/unique");
    expect(result.conflictingEntryPath).toBeNull();
  });
});
