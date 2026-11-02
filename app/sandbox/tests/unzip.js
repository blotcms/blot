describe("sandbox unzip job", function () {
  const zlib = require("zlib");
  const config = require("config");
  const sandbox = require("../");
  const { RATIO_FLOOR } = require("../jobs/unzip");

  let socket;

  beforeEach(function () {
    // no broker: the job runs in-process
    socket = config.sandbox.socket;
    config.sandbox.socket = "";
  });

  afterEach(function () {
    config.sandbox.socket = socket;
  });

  const TABLE = Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });

  function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  // Writes a zip by hand, since the libraries tidy up the names these specs
  // are about. A file is { name, data, mode } and mode is a unix file mode.
  function zip(files, { deflate = false } = {}) {
    const local = [];
    const central = [];
    let offset = 0;

    for (const { name, data = Buffer.alloc(0), mode = 0o100644 } of files) {
      const raw = Buffer.from(data);
      const body = deflate ? zlib.deflateRawSync(raw, { level: 9 }) : raw;
      const nameBytes = Buffer.from(name);

      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(deflate ? 8 : 0, 8);
      header.writeUInt32LE(crc32(raw), 14);
      header.writeUInt32LE(body.length, 18);
      header.writeUInt32LE(raw.length, 22);
      header.writeUInt16LE(nameBytes.length, 26);

      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE((3 << 8) | 20, 4);
      entry.writeUInt16LE(20, 6);
      entry.writeUInt16LE(deflate ? 8 : 0, 10);
      entry.writeUInt32LE(crc32(raw), 16);
      entry.writeUInt32LE(body.length, 20);
      entry.writeUInt32LE(raw.length, 24);
      entry.writeUInt16LE(nameBytes.length, 28);
      entry.writeUInt32LE((mode << 16) >>> 0, 38);
      entry.writeUInt32LE(offset, 42);

      local.push(header, nameBytes, body);
      central.push(entry, nameBytes);
      offset += header.length + nameBytes.length + body.length;
    }

    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);

    return Buffer.concat(local.concat(directory, end));
  }

  const LIMITS = { maxEntries: 20, maxBytes: 10 * 1024 * 1024, maxRatio: 200 };

  async function unzip(buffer, limits = {}) {
    return sandbox.run("unzip", Object.assign({}, LIMITS, limits), buffer);
  }

  it("returns the files of a normal template, not its directories", async function () {
    const { meta, outputs } = await unzip(
      zip(
        [
          { name: "theme/", mode: 0o040755 },
          { name: "theme/index.html", data: "<h1>{{title}}</h1>" },
          { name: "theme/css/style.css", data: "body { color: red }".repeat(50) },
          { name: "theme/package.json", data: JSON.stringify({ name: "Theme" }) },
        ],
        { deflate: true }
      )
    );

    expect(meta).toEqual({
      error: null,
      files: ["theme/index.html", "theme/css/style.css", "theme/package.json"],
    });
    expect(outputs.map(String)).toEqual([
      "<h1>{{title}}</h1>",
      "body { color: red }".repeat(50),
      JSON.stringify({ name: "Theme" }),
    ]);
  });

  it("accepts an empty archive", async function () {
    const { meta, outputs } = await unzip(zip([]));
    expect(meta).toEqual({ error: null, files: [] });
    expect(outputs).toEqual([]);
  });

  for (const name of [
    "../evil.html",
    "a/../../evil.html",
    "a\\..\\..\\evil.html",
    "/etc/passwd",
    "\\evil.html",
    "C:\\evil.html",
    "C:/evil.html",
    "a\u0000b.html",
  ]) {
    it("refuses the path " + JSON.stringify(name), async function () {
      const { meta, outputs } = await unzip(
        zip([{ name: "fine.html", data: "ok" }, { name, data: "x" }])
      );
      expect(meta.error.reason).toEqual("path");
      expect(meta.files).toEqual([]);
      expect(outputs).toEqual([]);
    });
  }

  it("refuses a directory entry that climbs out", async function () {
    const { meta } = await unzip(zip([{ name: "../dir/", mode: 0o040755 }]));
    expect(meta.error.reason).toEqual("path");
  });

  it("refuses a symlink", async function () {
    const { meta, outputs } = await unzip(
      zip([{ name: "link", data: "/etc/passwd", mode: 0o120777 }])
    );
    expect(meta.error).toEqual({ reason: "symlink", path: "link" });
    expect(outputs).toEqual([]);
  });

  it("refuses more records than allowed, directories included", async function () {
    const files = [];
    for (let i = 0; i < 21; i++) files.push({ name: "d" + i + "/", mode: 0o040755 });
    expect((await unzip(zip(files))).meta.error.reason).toEqual("count");
    expect((await unzip(zip(files.slice(0, 20)))).meta.error).toBe(null);
  });

  it("refuses files that declare more than allowed together", async function () {
    const { meta } = await unzip(
      zip([
        { name: "a", data: Buffer.alloc(600, 1) },
        { name: "b", data: Buffer.alloc(600, 2) },
      ]),
      { maxBytes: 1000 }
    );
    expect(meta.error.reason).toEqual("size");
    expect(meta.error.path).toEqual("b");
  });

  it("refuses a zip bomb by its ratio, reading no more than the floor", async function () {
    const bomb = zip([{ name: "zeros", data: Buffer.alloc(RATIO_FLOOR * 8) }], {
      deflate: true,
    });
    expect(bomb.length * 200).toBeLessThan(RATIO_FLOOR * 8);

    const { meta, outputs } = await unzip(bomb, { maxBytes: 20 * 1024 * 1024 });
    expect(meta.error).toEqual({ reason: "ratio", path: "zeros" });
    expect(outputs).toEqual([]);
  });

  it("does not apply the ratio to a small archive", async function () {
    const { meta } = await unzip(
      zip([{ name: "zeros", data: Buffer.alloc(RATIO_FLOOR / 2) }], { deflate: true })
    );
    expect(meta.error).toBe(null);
  });

  it("stops reading a file that is longer than it says", async function () {
    const data = Buffer.alloc(5000, 7);
    const archive = zip([{ name: "a", data }]);
    // the central directory claims 100 bytes; the data inflates to 5000
    const claimed = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    archive.writeUInt32LE(100, claimed + 24);
    archive.writeUInt32LE(100, 22);

    const { meta } = await unzip(archive, { maxBytes: 1000 });
    expect(["size", "read"]).toContain(meta.error.reason);
  });

  it("reports data that is not a zip", async function () {
    const { meta } = await unzip(Buffer.from("this is not a zip file"));
    expect(meta.error).toEqual({ reason: "zip" });
  });

  it("reports an entry it cannot read", async function () {
    const archive = zip([{ name: "a.html", data: "<p>hello</p>".repeat(200) }], {
      deflate: true,
    });
    for (let i = 36; i < 60; i++) archive[i] ^= 0xff;
    const { meta } = await unzip(archive);
    expect(meta.error.reason).toEqual("read");
  });

  it("checks its arguments", async function () {
    async function message(promise) {
      try {
        await promise;
      } catch (err) {
        return err.message;
      }
    }

    for (const limits of [
      { maxEntries: 0 },
      { maxEntries: 1e9 },
      { maxBytes: "10" },
      { maxBytes: 1e12 },
      { maxRatio: -1 },
      { maxRatio: undefined },
    ]) {
      expect(await message(unzip(zip([]), limits))).toEqual("invalid limits");
    }
    expect(await message(sandbox.run("unzip", null, zip([])))).toEqual("invalid arguments");
  });
});
