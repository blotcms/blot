describe("entry.backlinks", function () {
  require("./setup")();

  it("works", async function (done) {
    const path = "/post.txt";
    const contents = "Link: linker\n\n[linker](/linked)";

    const pathLinked = "/linked.txt";
    const contentsLinked = "Link: linked\n\nHey";

    await this.set(pathLinked, contentsLinked);
    await this.set(path, contents);

    const entry = await this.get(pathLinked);

    expect(entry.backlinks).toEqual(["/linker"]);
    done();
  });

  it("will not contain deleted internal links", async function (done) {
    const path = "/post.txt";
    const contents = "Link: linker\n\n[linker](/linked)";

    const pathLinked = "/linked.txt";
    const contentsLinked = "Link: linked\n\nHey";

    await this.set(pathLinked, contentsLinked);
    await this.set(path, contents);

    const entry = await this.get(pathLinked);

    const updatedContents = "Link: linker\n\nlinker";
    await this.set(path, updatedContents);

    const entryAfterUpdate = await this.get(pathLinked);

    expect(entry.backlinks).toEqual(["/linker"]);
    expect(entryAfterUpdate.backlinks).toEqual([]);
    done();
  });

  it("works with multiple files", async function (done) {
    const pathFirst = "/post-1.txt";
    const contentsFirst = "Link: linker-1\n\n[linker](/linked)";

    const pathSecond = "/post-2.txt";
    const contentsSecond = "Link: linker-2\n\n[linker](/linked)";

    const pathLinked = "/linked.txt";
    const contentsLinked = "Link: linked\n\nHey";

    await this.set(pathLinked, contentsLinked);
    await this.set(pathFirst, contentsFirst);
    await this.set(pathSecond, contentsSecond);

    const entry = await this.get(pathLinked);

    expect(entry.backlinks.sort()).toEqual(["/linker-1", "/linker-2"]);
    done();
  });

  it("won't contain internal links from deleted posts", async function (done) {
    const path = "/post.txt";
    const contents = "Link: linker\n\n[linker](/linked)";

    const pathLinked = "/linked.txt";
    const contentsLinked = "Link: linked\n\nHey";

    await this.set(pathLinked, contentsLinked);
    await this.set(path, contents);

    const entry = await this.get(pathLinked);

    await this.drop(path);

    const entryAfterDrop = await this.get(pathLinked);

    expect(entry.backlinks).toEqual(["/linker"]);
    expect(entryAfterDrop.backlinks).toEqual([]);
    done();
  });

  it("updates the backlink when the linker's URL changes", async function (done) {
    const path = "/post.txt";
    const contents = "Link: linker\n\n[linker](/linked)";

    const pathLinked = "/linked.txt";
    const contentsLinked = "Link: linked\n\nHey";

    await this.set(pathLinked, contentsLinked);
    await this.set(path, contents);

    const entry = await this.get(pathLinked);

    const updatedContents = "Link: new-linker\n\n[linker](/linked)";
    await this.set(path, updatedContents);

    const entryAfterUpdate = await this.get(pathLinked);

    expect(entry.backlinks).toEqual(["/linker"]);
    expect(entryAfterUpdate.backlinks).toEqual(["/new-linker"]);
    done();
  });

  it("updates the backlinks property of deleted posts", async function (done) {
    const path = "/post.txt";
    const contents = "Link: linker\n\n[linker](/linked)";

    const pathLinked = "/linked.txt";
    const contentsLinked = "Link: linked\n\nHey";

    await this.set(pathLinked, contentsLinked);
    await this.set(path, contents);

    const entry = await this.get(pathLinked);

    await this.drop(pathLinked);
    await this.drop(path);

    const entryAfterDrop = await this.get(pathLinked);

    await this.set(pathLinked, contentsLinked);

    const entryAfterRestore = await this.get(pathLinked);

    expect(entry.backlinks).toEqual(["/linker"]);
    expect(entryAfterDrop.deleted).toEqual(true);
    expect(entryAfterRestore.backlinks).toEqual([]);
    done();
  });

  it("tracks backlinks for unicode target URLs linked from ASCII linkers", async function (done) {
    const pathTarget = "/unicode-target.txt";
    const contentsTarget = "Permalink: grüße\n\nHey";

    const pathLinker = "/ascii-linker.txt";
    const contentsLinker = "Link: linker\n\n[grüße](/grüße)";

    await this.set(pathTarget, contentsTarget);
    await this.set(pathLinker, contentsLinker);

    const entry = await this.get(pathTarget);

    const updatedContentsLinker = "Link: linker\n\nNo internal link";
    await this.set(pathLinker, updatedContentsLinker);

    const entryAfterUpdate = await this.get(pathTarget);

    expect(entry.backlinks).toEqual(["/linker"]);
    expect(entryAfterUpdate.backlinks).toEqual([]);
    done();
  });

  it("preserves unicode linker permalinks in backlinks", async function (done) {
    const pathTarget = "/linked.txt";
    const contentsTarget = "Link: linked\n\nHey";

    const pathLinker = "/unicode-linker.txt";
    const contentsLinker = "Permalink: über-uns\n\n[linked](/linked)";

    await this.set(pathTarget, contentsTarget);
    await this.set(pathLinker, contentsLinker);

    const entry = await this.get(pathTarget);

    const updatedContentsLinker =
      "Permalink: über-uns-neu\n\n[linked](/linked)";
    await this.set(pathLinker, updatedContentsLinker);

    const entryAfterUpdate = await this.get(pathTarget);

    expect(entry.backlinks).toEqual(["/über-uns"]);
    expect(entryAfterUpdate.backlinks).toEqual(["/über-uns-neu"]);
    done();
  });
});
