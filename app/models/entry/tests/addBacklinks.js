describe("entry.set.addBacklinks", function () {
  require("./setup")();

  const addBacklinks = require("../set").addBacklinks;

  it("adds the backlink a linker saved before its target missed", async function () {
    // Saved before its target, so there is nothing to add a backlink to
    await this.set("/linker.txt", "Link: linker\n\n[t](/target)");
    await this.set("/target.txt", "Link: target\n\nTarget");

    expect((await this.get("/target.txt")).backlinks).toEqual([]);

    expect(await addBacklinks(this.blog.id, "/linker.txt")).toEqual([
      "/target.txt",
    ]);

    // What saving the target first gives
    expect((await this.get("/target.txt")).backlinks).toEqual(["/linker"]);

    // A second pass adds nothing
    expect(await addBacklinks(this.blog.id, "/linker.txt")).toEqual([]);
    expect((await this.get("/target.txt")).backlinks).toEqual(["/linker"]);
  });

  it("only adds, keeping the target's other backlinks", async function () {
    await this.set("/target.txt", "Link: target\n\nTarget");
    await this.set("/first.txt", "Link: first\n\n[t](/target)");
    await this.set("/second.txt", "Link: second\n\n[t](/target)");

    expect(await addBacklinks(this.blog.id, "/first.txt")).toEqual([]);
    expect((await this.get("/target.txt")).backlinks.sort()).toEqual([
      "/first",
      "/second",
    ]);
  });

  it("does nothing for a deleted or missing entry", async function () {
    await this.set("/linker.txt", "Link: linker\n\n[t](/target)");
    await this.set("/target.txt", "Link: target\n\nTarget");
    await this.drop("/linker.txt");

    expect(await addBacklinks(this.blog.id, "/linker.txt")).toEqual([]);
    expect(await addBacklinks(this.blog.id, "/missing.txt")).toEqual([]);
    expect((await this.get("/target.txt")).backlinks).toEqual([]);
  });
});
