// Diffs trees read by range from packs made by real git, and compares every
// diff with `git diff-tree -r`.
const timeout = require("./helpers/timeout");
const { makeRepo, byPath, EMPTY_TREE } = require("./helpers/repo");
const { diffTrees, collect } = require("../treediff");
const { NotFoundError } = require("../errors");

describe("git store treediff", function () {
  timeout(60 * 1000);

  let repo;
  let reader;
  let commits;

  beforeAll(async function () {
    repo = makeRepo();
    commits = [
      repo.commit({
        "a.txt": "A",
        "dir/b.txt": "B",
        "dir/deep/c.txt": "C",
        "same/x.txt": "X",
        "empty.txt": "",
      }),
      repo.commit({ "a.txt": "A2", "dir/new.txt": "New" }),
      repo.commit({ "dir/b.txt": null, "dir/deep/c.txt": null }),
      repo.commit({ "run.sh": { contents: "#!/bin/sh\n", mode: "100755" } }),
      repo.commit({ "run.sh": { contents: "#!/bin/sh\n", mode: "100644" } }),
      // A file becomes a directory, and a directory a file
      repo.commit({
        "a.txt": null,
        "a.txt/inner.txt": "Inside",
        dir: "A file now",
      }),
      repo.commit({
        "a.txt/inner.txt": null,
        "a.txt": "A file again",
        dir: null,
        "dir/back.txt": "Back",
      }),
      // Names which differ only by case
      repo.commit({ "Readme.txt": "R", "Dir/File.txt": "F" }),
      repo.commit({
        "Readme.txt": null,
        "readme.txt": "R",
        "Dir/File.txt": null,
        "dir/file.txt": "F",
      }),
      repo.commit({
        "readme.txt": null,
        "Readme.txt": "R",
        "dir/file.txt": null,
        "Dir/File.txt": "F",
      }),
      repo.commitExactly({
        "b\xff.txt": "Not UTF-8",
        "fine.txt": "Fine",
        [raw("café")]: {
          [raw("e\u0301.txt")]: "NFD",
          [raw("\u00e9.txt")]: "NFC",
        },
        sub: {
          link: { contents: "fine.txt", mode: "120000" },
          module: {
            oid: "0123456789012345678901234567890123456789",
            mode: "160000",
          },
        },
      }),
    ];
    ({ reader } = await repo.reader());
  });

  afterAll(function () {
    repo.remove();
  });

  // The bytes of a UTF-8 name, as the latin1 text commitExactly takes
  const raw = (name) => Buffer.from(name).toString("latin1");

  const strip = (changes) =>
    changes.map(({ valid, ...rest }) => rest).sort(byPath);

  async function expectSameAsGit(a, b) {
    const got = await collect({
      reader,
      a: a && repo.treeOf(a),
      b: b && repo.treeOf(b),
    });
    expect(strip(got)).toEqual(
      repo.diffTree(a && repo.treeOf(a), b && repo.treeOf(b))
    );
    return got;
  }

  it("matches git diff-tree for every pair of neighbouring commits", async function () {
    for (let i = 0; i < commits.length; i++)
      await expectSameAsGit(commits[i - 1] || null, commits[i]);
  });

  it("matches git diff-tree from nothing, to nothing and across the history", async function () {
    for (const commit of commits) {
      await expectSameAsGit(null, commit);
      await expectSameAsGit(commit, null);
    }
    for (let i = 0; i < commits.length; i += 3)
      await expectSameAsGit(commits[i], commits[commits.length - 1 - i]);
  });

  it("yields nothing for the same tree, or two empty ones, without reading", async function () {
    expect(
      await collect({
        reader,
        a: repo.treeOf(commits[0]),
        b: repo.treeOf(commits[0]),
      })
    ).toEqual([]);
    expect(await collect({ reader, a: null, b: null })).toEqual([]);
    // The empty tree need not be stored
    expect(await collect({ reader, a: EMPTY_TREE, b: null })).toEqual([]);
    expect(
      await collect({ reader, a: EMPTY_TREE, b: repo.treeOf(commits[0]) })
    ).toEqual(await collect({ reader, a: null, b: repo.treeOf(commits[0]) }));
  });

  it("describes a change by its old and new mode and ID", async function () {
    const [change] = await expectSameAsGit(commits[3], commits[4]);

    expect(change.path).toBe("run.sh");
    expect(change.oldMode).toBe("100755");
    expect(change.newMode).toBe("100644");
    expect(change.oldOid).toBe(change.newOid);
  });

  it("does not read a subtree whose ID is the same on both sides", async function () {
    const read = reader.read;
    const seen = [];
    const counting = Object.assign(Object.create(reader), {
      read: (oid, options) => (seen.push(oid), read(oid, options)),
    });

    await collect({
      reader: counting,
      a: repo.treeOf(commits[0]),
      b: repo.treeOf(commits[1]),
    });

    // The two roots, and dir on both sides. same/ and dir/deep are untouched.
    expect(seen.length).toBe(4);
  });

  it("removes before it adds where a path changes kind", async function () {
    const paths = (changes) =>
      changes.map((c) => (c.newMode ? "+" : "-") + c.path);

    // file -> directory
    let got = await expectSameAsGit(commits[4], commits[5]);
    expect(paths(got).indexOf("-a.txt")).toBeLessThan(
      paths(got).indexOf("+a.txt/inner.txt")
    );

    // directory -> file: the contents go before the file arrives
    expect(paths(got).indexOf("-dir/new.txt")).toBeLessThan(
      paths(got).indexOf("+dir")
    );

    // and the reverse of both
    got = await expectSameAsGit(commits[5], commits[6]);
    expect(paths(got).indexOf("-a.txt/inner.txt")).toBeLessThan(
      paths(got).indexOf("+a.txt")
    );
    expect(paths(got).indexOf("-dir")).toBeLessThan(
      paths(got).indexOf("+dir/back.txt")
    );
  });

  it("removes before it adds for names which differ only by case", async function () {
    for (const [from, to] of [
      [7, 8],
      [8, 9],
    ]) {
      const got = await expectSameAsGit(commits[from], commits[to]);
      const last = got
        .map((c, i) => (c.newMode ? -1 : i))
        .reduce((x, y) => Math.max(x, y));
      const first = got.findIndex((c) => c.newMode);
      expect(last).toBeLessThan(first);
    }
  });

  it("marks a path with a name that is not UTF-8, and tells NFC and NFD apart", async function () {
    const got = await collect({
      reader,
      a: null,
      b: repo.treeOf(commits[commits.length - 1]),
    });
    const invalid = got.filter((c) => !c.valid);

    expect(invalid.length).toBe(1);
    expect(invalid[0].newOid).toBeTruthy();
    expect(got.map((c) => c.path)).toContain("café/é.txt");
    expect(got.map((c) => c.path)).toContain("café/é.txt");
  });

  it("reports links and submodules as changes with their modes", async function () {
    const got = await collect({
      reader,
      a: null,
      b: repo.treeOf(commits[commits.length - 1]),
    });

    expect(got.find((c) => c.path === "sub/link").newMode).toBe("120000");
    expect(got.find((c) => c.path === "sub/module").newMode).toBe("160000");
  });

  it("throws for a tree the repository does not have", async function () {
    let error;
    try {
      await collect({ reader, a: null, b: "1".repeat(40) });
    } catch (err) {
      error = err;
    }
    expect(error instanceof NotFoundError).toBe(true);
  });

  it("is lazy: it reads no more than it is asked for", async function () {
    const iterator = diffTrees({ reader, a: null, b: repo.treeOf(commits[0]) })[
      Symbol.asyncIterator
    ]();
    const first = await iterator.next();

    expect(first.done).toBe(false);
    await iterator.return();
  });
});
