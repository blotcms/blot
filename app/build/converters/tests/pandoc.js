describe("pandoc converter", function () {
  const fs = require("fs-extra");
  const path = require("path");
  const yauzl = require("yauzl");
  const sandbox = require("sandbox");
  const pandoc = require("../pandoc");

  const docx = path.join(__dirname, "../docx/tests/image.docx");

  // The archive's files by name
  function files(file) {
    return new Promise((resolve, reject) => {
      const found = new Map();
      yauzl.open(file, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);
        zipfile.on("entry", (entry) => {
          zipfile.openReadStream(entry, (err, stream) => {
            if (err) return reject(err);
            const chunks = [];
            stream.on("data", (chunk) => chunks.push(chunk));
            stream.on("end", () => {
              found.set(entry.fileName, Buffer.concat(chunks));
              zipfile.readEntry();
            });
          });
        });
        zipfile.on("end", () => resolve(found));
        zipfile.readEntry();
      });
    });
  }

  it("reads a docx's images from the archive, not pandoc's reply", async function () {
    const run = sandbox.run;
    const jobs = [];
    spyOn(sandbox, "run").and.callFake((job, args, input) => {
      jobs.push(job);
      return run(job, args, input);
    });

    const { html, media } = await pandoc({ from: "docx" }, { path: docx });

    expect(jobs).toEqual(["pandoc", "unzip"]);
    expect(media.length).toBe(2);
    const archive = await files(docx);
    for (const { name, data } of media) {
      expect(html).toContain(name);
      expect(data.equals(archive.get("word/" + name))).toBe(true);
    }
  });

  it("reads them in batches when they don't fit in one reply", async function () {
    const run = sandbox.run;
    const batches = [];
    spyOn(sandbox, "run").and.callFake((job, args, input) => {
      if (job !== "unzip") return run(job, args, input);
      // A batch of one image at a time
      args = Object.assign({}, args, { maxBytes: 1 });
      return run(job, args, input).then((reply) => {
        batches.push(reply.meta.files);
        return reply;
      });
    });

    // Each image is larger than a byte, so each batch refuses all but its first
    const err = await pandoc({ from: "docx" }, { path: docx }).catch(
      (err) => err
    );
    expect(err.message).toContain("could not read the document's images");
    expect(batches.length).toBe(1);
  });

  it("asks again for the images a batch left out", async function () {
    const run = sandbox.run;
    const batches = [];
    const archive = await files(docx);
    const sizes = [...archive]
      .filter(([name]) => name.startsWith("word/media/"))
      .map(([, data]) => data.length);
    spyOn(sandbox, "run").and.callFake((job, args, input) => {
      if (job !== "unzip") return run(job, args, input);
      // Room for the largest image, but not for two
      args = Object.assign({}, args, { maxBytes: Math.max(...sizes) });
      return run(job, args, input).then((reply) => {
        batches.push(reply.meta.files);
        return reply;
      });
    });

    const { media } = await pandoc({ from: "docx" }, { path: docx });

    expect(batches.length).toBe(2);
    expect(batches.flat().sort()).toEqual(
      media.map(({ name }) => "word/" + name).sort()
    );
    for (const { name, data } of media)
      expect(data.equals(archive.get("word/" + name))).toBe(true);
  });

  it("converts a document with no images in one job", async function () {
    const jobs = [];
    const run = sandbox.run;
    spyOn(sandbox, "run").and.callFake((job, args, input) => {
      jobs.push(job);
      return run(job, args, input);
    });

    const input = await fs.readFile(
      path.join(__dirname, "../docx/tests/paragraph.docx")
    );
    const { media } = await pandoc({ from: "docx" }, input);

    expect(media).toEqual([]);
    expect(jobs).toEqual(["pandoc"]);
  });
});
