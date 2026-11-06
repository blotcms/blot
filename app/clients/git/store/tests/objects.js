// The parsers for commits, trees and tags, the reverse index and the scan of
// an incoming pack, each checked against what real git says about the same bytes.
const fs = require("fs");
const path = require("path");
const fx = require("./helpers/fixture");
const objects = require("../objects");
const { buildRev } = require("../rev");
const { scanPack } = require("../packscan");
const { CorruptError } = require("../errors");

function fails(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

describe("git store objects", function () {
  let dir;
  let fixture;

  beforeAll(function () {
    dir = fx.tempDir();
    fixture = fx.buildFixture(path.join(dir, "src"), {
      commits: 4,
      large: false,
    });
  });

  afterAll(() => fx.remove(dir));

  const src = () => path.join(dir, "src");

  it("parses a commit", function () {
    const commit = objects.parseCommit(
      fx.git(src(), ["cat-file", "commit", fixture.head])
    );
    expect(commit.tree).toBe(
      fx.text(src(), ["rev-parse", fixture.head + "^{tree}"])
    );
    expect(commit.parents).toEqual([
      fixture.commits[fixture.commits.length - 2],
    ]);
    expect(commit.author).toMatch(/^Test <test@example.com> \d+ /);
    expect(commit.message).toBe("Commit 4\n");
    expect(
      objects.parseCommit(
        fx.git(src(), ["cat-file", "commit", fixture.commits[0]])
      ).parents
    ).toEqual([]);
  });

  it("parses a merge and a signature header", function () {
    const text = [
      "tree " + "a".repeat(40),
      "parent " + "b".repeat(40),
      "parent " + "c".repeat(40),
      "author A <a@example.com> 1 +0000",
      "committer A <a@example.com> 1 +0000",
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " ",
      " abc",
      " -----END PGP SIGNATURE-----",
      "",
      "Merge",
      "",
    ].join("\n");
    const commit = objects.parseCommit(Buffer.from(text));
    expect(commit.parents).toEqual(["b".repeat(40), "c".repeat(40)]);
    expect(commit.message).toBe("Merge\n");
  });

  it("parses a tree", function () {
    const listing = fx
      .text(src(), ["ls-tree", fixture.head])
      .split("\n")
      .map((line) => {
        const [mode, , oid, name] = line.split(/[\t ]/);
        return { mode: String(Number(mode)), oid, name };
      });
    const tree = objects.parseTree(
      fx.git(src(), ["cat-file", "tree", fixture.head + "^{tree}"])
    );

    expect(
      tree.map((e) => ({ mode: e.mode, oid: e.oid, name: e.name }))
    ).toEqual(listing);
    expect(tree.some(objects.isDirectory)).toBe(true);
    expect(tree.some(objects.isGitlink)).toBe(false);
    expect(objects.parseTree(Buffer.alloc(0))).toEqual([]);
  });

  it("parses a tag", function () {
    const tag = objects.parseTag(
      fx.git(src(), ["cat-file", "tag", fixture.tag])
    );
    expect(tag).toEqual(
      jasmine.objectContaining({
        object: fixture.head,
        type: "commit",
        tag: "v1",
        message: "Version 1\n",
      })
    );
  });

  it("rejects what is not an object of that kind", function () {
    expect(fails(() => objects.parseCommit(Buffer.from("hello\n")))).toEqual(
      jasmine.any(CorruptError)
    );
    expect(
      fails(() =>
        objects.parseCommit(Buffer.from("tree xyz\nauthor a\ncommitter a\n\nm"))
      )
    ).toEqual(jasmine.any(CorruptError));
    expect(
      fails(() => objects.parseTree(Buffer.from("100644 name\0short")))
    ).toEqual(jasmine.any(CorruptError));
    expect(fails(() => objects.parseTree(Buffer.from("junk")))).toEqual(
      jasmine.any(CorruptError)
    );
    expect(
      fails(() =>
        objects.parseTag(
          Buffer.from("object " + "a".repeat(40) + "\n\nno type")
        )
      )
    ).toEqual(jasmine.any(CorruptError));
  });

  describe("reverse index", function () {
    for (const refDeltas of [false, true]) {
      it(
        "matches git's own, for a pack with " +
          (refDeltas ? "REF_DELTA" : "OFS_DELTA") +
          " entries",
        function () {
          fx.repackAll(src(), { refDeltas });
          const [pack] = fx.readPacks(src());

          const work = fx.tempDir();
          try {
            fs.writeFileSync(path.join(work, "in.pack"), pack.pack);
            fx.git(work, ["index-pack", "--rev-index", "in.pack"]);
            expect(
              buildRev(fs.readFileSync(path.join(work, "in.idx"))).equals(
                fs.readFileSync(path.join(work, "in.rev"))
              )
            ).toBe(true);
            expect(buildRev(pack.idx).length).toBe(
              12 + 4 * fx.listEntries(pack).length + 40
            );
          } finally {
            fx.remove(work);
          }
        }
      );
    }

    it("reads offsets from the table for packs over 2 GB", function () {
      fx.repackAll(src());
      const [pack] = fx.readPacks(src());
      const entries = fx.listEntries(pack);
      const small = buildRev(fx.buildIdx(entries, pack.pack));
      const large = buildRev(fx.buildIdx(entries, pack.pack, { largeFrom: 1 }));
      expect(large.equals(small)).toBe(true);
    });
  });

  describe("scanning a pack", function () {
    let file;

    beforeEach(() => (file = path.join(fx.tempDir(), "in.pack")));
    afterEach(() => fx.remove(path.dirname(file)));

    it("finds the bases a thin pack needs and does not contain", async function () {
      fs.writeFileSync(
        path.join(src(), "docs", "big.txt"),
        fs
          .readFileSync(path.join(src(), "docs", "big.txt"), "utf8")
          .replace("line 3 ", "line 3 more ")
      );
      fx.git(src(), ["commit", "-q", "-am", "Edit"]);
      const tip = fx.text(src(), ["rev-parse", "HEAD"]);

      fs.writeFileSync(
        file,
        fx.packRevs(src(), [tip], [fixture.head], { thin: true })
      );
      const scanned = await scanPack(file);

      expect(scanned.count).toBe(
        fx
          .text(src(), ["rev-list", "--objects", tip, "^" + fixture.head])
          .split("\n").length
      );
      expect(scanned.whole.has(tip)).toBe(true);
      const outside = [...scanned.bases].filter(
        (oid) => !scanned.whole.has(oid)
      );
      expect(outside.length).toBeGreaterThan(0);
      for (const oid of outside)
        expect(fx.text(src(), ["cat-file", "-t", oid])).toMatch(/blob|tree/);
    });

    it("names only objects of the pack as bases, in one which is complete", async function () {
      // Without ofs-delta a delta against another delta in the pack is named by ID too
      fs.writeFileSync(file, fx.packRevs(src(), [fixture.head], []));
      const scanned = await scanPack(file);
      const inPack = new Set(
        fx
          .text(src(), ["rev-list", "--objects", fixture.head])
          .split("\n")
          .map((line) => line.split(" ")[0])
      );

      expect(scanned.whole.has(fixture.head)).toBe(true);
      for (const oid of scanned.bases) expect(inPack.has(oid)).toBe(true);
    });

    it("reads a pack with no objects", async function () {
      fs.writeFileSync(file, fx.packRevs(src(), [], []));
      expect((await scanPack(file)).count).toBe(0);
    });

    it("rejects a pack which is cut short, padded, or not a pack", async function () {
      const pack = fx.packRevs(src(), [fixture.head], []);

      for (const bad of [
        pack.subarray(0, pack.length - 30),
        Buffer.concat([pack, Buffer.from("extra")]),
        Buffer.from("not a pack at all, no, not even close"),
      ]) {
        fs.writeFileSync(file, bad);
        let error;
        try {
          await scanPack(file);
        } catch (err) {
          error = err;
        }
        expect(error).toEqual(jasmine.any(CorruptError));
      }
    });
  });
});
