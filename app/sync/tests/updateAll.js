describe("sync updateAll", function () {
  const updateAll = require("../updateAll");
  const config = require("config");
  const { SimpleError } = require("redis");

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // A fake update which records how many ran at once and in what order
  function recorder() {
    const record = { started: [], running: 0, most: 0, overlaps: [] };
    const now = new Set();

    record.update = async (path) => {
      record.started.push(path);
      record.running++;
      record.most = Math.max(record.most, record.running);
      now.forEach((other) => record.overlaps.push([other, path]));
      now.add(path);
      await sleep(5 + Math.floor(Math.random() * 10));
      now.delete(path);
      record.running--;
      return { path };
    };

    return record;
  }

  const paths = [
    "/a.txt",
    "/album+/1.jpg",
    "/b.txt",
    "/album+/2.jpg",
    "/c.txt",
    "/album+/3.jpg",
    "/d.txt",
  ];

  it("is off by default", function () {
    expect(config.sync.concurrent_builds).toBe(false);
  });

  it("updates one path at a time, in order, when off", async function () {
    const record = recorder();
    const outcomes = await updateAll("blog", paths, record.update);

    expect(record.most).toBe(1);
    expect(record.started).toEqual(paths);
    expect(outcomes.map((outcome) => outcome.result.path)).toEqual(paths);
  });

  it("updates up to the limit at once, and a '+' folder's files in turn", async function () {
    const record = recorder();
    const outcomes = await updateAll("blog", paths, record.update, {
      limit: 3,
    });

    expect(record.most).toBe(3);

    // The folder's files never overlap and keep their order
    const inAlbum = (path) => path.indexOf("/album+/") === 0;
    expect(record.overlaps.filter((pair) => pair.every(inAlbum))).toEqual([]);
    expect(record.started.filter(inAlbum)).toEqual([
      "/album+/1.jpg",
      "/album+/2.jpg",
      "/album+/3.jpg",
    ]);

    // Outcomes are in the order of the paths given
    expect(outcomes.map((outcome) => outcome.path)).toEqual(paths);
    expect(outcomes.map((outcome) => outcome.result.path)).toEqual(paths);
  });

  it("collects other errors and carries on", async function () {
    const outcomes = await updateAll(
      "blog",
      ["/a.txt", "/b.txt", "/c.txt"],
      async (path) => {
        if (path === "/b.txt") throw new Error("broken");
        return {};
      },
      { limit: 3 }
    );

    expect(outcomes.map((outcome) => !!outcome.error)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("stops at a Redis outage, once the paths already started finish", async function () {
    const started = [];
    const finished = [];
    const many = ["/1", "/2", "/3", "/4", "/5", "/6", "/7", "/8"];

    let error;

    try {
      await updateAll(
        "blog",
        many,
        async (path) => {
          started.push(path);
          if (path === "/2")
            throw new SimpleError(
              "NOREPLICAS Not enough good replicas to write."
            );
          await sleep(20);
          finished.push(path);
        },
        { limit: 3 }
      );
    } catch (err) {
      error = err;
    }

    expect(error && error.message).toContain("NOREPLICAS");
    expect(started.length).toBe(3);
    expect(finished.sort()).toEqual(["/1", "/3"]);
  });
});
