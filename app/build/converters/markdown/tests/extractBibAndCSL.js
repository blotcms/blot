const folder = require("storage/folder");
const extractBibAndCSL = require("../extractBibAndCSL");
const extractMetadata = require("build/metadata");

// Resolves to { err, bib, csl }
function extract(blog, path, metadata) {
  return new Promise(function (resolve) {
    extractBibAndCSL(blog, path, metadata, (err, bib, csl) => {
      resolve({ err, bib, csl });
    });
  });
}

describe("markdown converter bib/csl extractor", function () {
  global.test.blog();

  // The extractor hands back the local paths pandoc is to read, which are
  // where the folder's files are cached
  const local = (blog, path) => folder.ensureLocal(blog.id, path);

  it("extracts a bib and csl", async function () {
    let path = "/Hello.txt";
    let text = `CSL: hey.csl\nBibliography: you.bib`;
    let metadata = extractMetadata(text).metadata;
    await test.folder.writeFiles(this.blog.id, {
      "/hey.csl": "Hey",
      "/you.bib": "Hey",
    });
    const { err, bib, csl } = await extract(this.blog, path, metadata);
    if (err) throw err;
    expect(bib).toEqual(await local(this.blog, "/you.bib"));
    expect(csl).toEqual(await local(this.blog, "/hey.csl"));
  });

  it("only extracts a bib and csl whose files exist", async function () {
    let path = "/Hello.txt";
    let text = `CSL: hey.csl\nBibliography: you.bib`;
    let metadata = extractMetadata(text).metadata;
    await test.folder.writeFiles(this.blog.id, { "/you.bib": "Hey" });
    const { err, bib, csl } = await extract(this.blog, path, metadata);
    if (err) throw err;
    expect(bib).toEqual(await local(this.blog, "/you.bib"));
    expect(csl).toEqual("");
  });

  it("resolves a relative bib and csl", async function () {
    let path = "/Hello/world.txt";
    let text = `CSL: ../hEY.csl\nBibliography: yOu.bib`;
    let metadata = extractMetadata(text).metadata;

    await test.folder.writeFiles(this.blog.id, {
      "/Hello/you.bib": "Hey",
      "/hey.csl": "Hey",
    });
    const { err, bib, csl } = await extract(this.blog, path, metadata);
    if (err) throw err;
    expect(bib).toEqual(await local(this.blog, "/Hello/you.bib"));
    expect(csl).toEqual(await local(this.blog, "/hey.csl"));
  });

  it("resolves an absolute bib and csl", async function () {
    let path = "/Hello/yOu/World.txt";
    let text = `CSL: /Hello/hEY.csl\nBibliography: /yOu.bib`;
    let metadata = extractMetadata(text).metadata;

    await test.folder.writeFiles(this.blog.id, {
      "/you.bib": "Hey",
      "/Hello/hey.csl": "Hey",
    });
    const { err, bib, csl } = await extract(this.blog, path, metadata);
    if (err) throw err;
    expect(bib).toEqual(await local(this.blog, "/you.bib"));
    expect(csl).toEqual(await local(this.blog, "/Hello/hey.csl"));
  });
});
