const fs = require("fs");
const vm = require("vm");

describe("google drive searchEdits", function () {
  // Loads searchEdits.js with readChanges stubbed: every file belongs to
  // blog_a unless its name starts with "other"
  function load() {
    const stubs = {
      "helper/clfdate": () => "[date]",
      "./readChanges": {
        blogsOf: async () => [{ blogID: "blog_a", folderId: "f" }],
        placeChanges: async (blogs, changes) =>
          changes.map((change) => ({
            change,
            blogID: change.file.name.startsWith("other") ? null : "blog_a",
          })),
      },
    };
    const module = { exports: {} };
    vm.runInNewContext(
      fs.readFileSync(require.resolve("../searchEdits"), "utf8"),
      {
        module,
        exports: module.exports,
        console: { log() {}, error() {} },
        setTimeout,
        clearTimeout,
        Date,
        require: (name) => (name in stubs ? stubs[name] : require(name)),
      }
    );
    return module.exports;
  }

  const file = (id, modifiedTime, extra = {}) => ({
    id,
    name: id + ".md",
    modifiedTime,
    md5Checksum: "md5",
    trashed: false,
    parents: ["p"],
    ...extra,
  });

  // Runs the search over `rounds` (one listing per round) and collects what
  // it passes on
  async function run(rounds) {
    const searchEdits = load();
    const passed = [];
    const queries = [];
    let round = 0;
    const drive = {
      files: {
        list: async (params) => {
          queries.push(params);
          const files = rounds[Math.min(round, rounds.length - 1)];
          round += 1;
          return { data: { files } };
        },
      },
    };
    const controller = new AbortController();
    const running = searchEdits("sa", drive, controller.signal, {
      pollMs: 2,
      onChanges: async (sa, placed, source) => {
        passed.push(...placed.map((p) => [source, p.change.fileId]));
      },
    });
    while (round < rounds.length + 1)
      await new Promise((resolve) => setTimeout(resolve, 2));
    controller.abort();
    await running;
    return { passed, queries };
  }

  const t = (s) => new Date(Date.now() - s * 1000).toISOString();

  it("only notes what is there on its first search", async function () {
    const time = t(10);
    const { passed } = await run([[file("a", time)], [file("a", time)]]);

    expect(passed).toEqual([]);
  });

  it("passes on a file edited since, once per edit", async function () {
    const first = t(10);
    const edit = t(1);
    const { passed } = await run([
      [file("a", first)],
      [file("a", edit)],
      [file("a", edit)],
      [file("b", t(0)), file("a", edit)],
    ]);

    expect(passed).toEqual([
      ["search", "a"],
      ["search", "b"],
    ]);
  });

  it("passes on a rename or trash with the same modified time", async function () {
    const time = t(10);
    const { passed } = await run([
      [file("a", time)],
      [file("a", time, { name: "renamed.md" })],
      [file("a", time, { name: "renamed.md", trashed: true })],
    ]);

    expect(passed).toEqual([
      ["search", "a"],
      ["search", "a"],
    ]);
  });

  it("drops files no blog holds", async function () {
    const { passed } = await run([[], [file("other", t(1))]]);

    expect(passed).toEqual([]);
  });

  it("asks for files modified in the last five minutes, newest first", async function () {
    const { queries } = await run([[]]);
    const since = Date.parse(queries[0].q.match(/'(.*)'/)[1]);

    expect(queries[0].orderBy).toBe("modifiedTime desc");
    expect(Math.abs(Date.now() - since - 5 * 60 * 1000)).toBeLessThan(2000);
  });
});
