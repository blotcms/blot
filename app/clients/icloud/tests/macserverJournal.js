// The macserver saves the last rank of bird's change journal it has handled,
// and on startup pushes what changed since. The pushes are queued in memory,
// so the rank saved must only move past a change once its push is done, or a
// restart loses every push still queued. A resolve hook swaps birdState.js,
// for journal.js only, for a fake of bird's database held on
// globalThis.__journalMocks; each test imports a fresh copy of journal.js.
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { register } = require("module");
const { pathToFileURL } = require("url");

const journalURL = pathToFileURL(
  path.join(__dirname, "../macserver/journal.js")
).href;

const hooks = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "dotenv/config") {
    try {
      return await nextResolve(specifier, context);
    } catch (e) {
      return { url: "data:text/javascript,", shortCircuit: true };
    }
  }
  if (
    context.parentURL &&
    context.parentURL.includes("/macserver/journal.js") &&
    specifier === "./birdState.js"
  ) {
    return {
      url: "data:text/javascript," + encodeURIComponent(
        "export const database = async () => globalThis.__journalMocks.db;"
      ),
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
`;

// bird's client_items, as the rows journal.js selects
function fakeDatabase(rows) {
  const prepare = (sql) => {
    if (sql.includes("max(item_notifs_rank)"))
      return { get: () => ({ m: Math.max(0, ...rows.map((r) => r.rank)) }) };
    if (sql.includes("item_notifs_rank > ?"))
      return {
        all: (rank) =>
          rows.filter((r) => r.rank > rank).sort((a, b) => a.rank - b.rank),
      };
    if (sql.includes("item_parent_zone_rowid = ?"))
      return {
        all: (z, id) => rows.filter((r) => r.pz === z && r.pid === id),
      };
    return { all: () => rows };
  };
  return { prepare };
}

// blog_journal's folder (zone 1) holds the shared folder, the root of zone 2
const folders = [
  { z: 1, id: "C", pz: 1, pid: "ROOT", name: "blog_journal", type: 0, rank: 1 },
  { z: 2, id: "R", pz: 1, pid: "C", name: "Shared", type: 0, rank: 1 },
];
const file = (name, rank) => ({
  z: 2,
  id: name,
  pz: 2,
  pid: "R",
  name,
  type: 1,
  rank,
});

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

describe("icloud macserver journal", function () {
  test.timeout(15000);

  const stateFile = path.join(
    os.tmpdir(),
    `macserver-journal-${process.pid}`,
    "journal.json"
  );
  let copies = 0;
  let rows;

  const loadJournal = () => import(`${journalURL}?copy=${copies++}`);
  const savedRank = async () => (await fs.readJson(stateFile)).rank;
  const waitFor = async (check) => {
    for (let waited = 0; waited < 10000; waited += 50) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("timed out");
  };

  beforeAll(function () {
    process.env.JOURNAL_STATE_FILE = stateFile;
    register("data:text/javascript," + encodeURIComponent(hooks));
  });

  afterAll(async function () {
    delete process.env.JOURNAL_STATE_FILE;
    delete globalThis.__journalMocks;
    await fs.remove(path.dirname(stateFile));
  });

  beforeEach(function () {
    spyOn(console, "log");
    spyOn(console, "warn");
    rows = [...folders];
    globalThis.__journalMocks = { db: fakeDatabase(rows) };
  });

  it("keeps the saved position until the pushes of a replay are done", async function () {
    await fs.outputJson(stateFile, { rank: 5 });
    rows.push(file("a.md", 10));
    const journal = await loadJournal();

    const replay = await journal.openJournal();
    expect(replay).toEqual([
      { blogID: "blog_journal", path: "a.md", isFile: true },
    ]);

    const push = deferred();
    journal.trackReplay([push.promise]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await savedRank()).toBe(5);

    push.resolve();
    await waitFor(async () => (await savedRank()) === 10);
  });

  it("keeps the saved position until a change it read has been pushed", async function () {
    await fs.outputJson(stateFile, { rank: 10 });
    rows.push(file("a.md", 10));
    const journal = await loadJournal();
    expect(await journal.openJournal()).toEqual([]);

    const pushes = [];
    journal.startJournal((blogID, p) => {
      const push = deferred();
      pushes.push({ blogID, path: p, push });
      return push.promise;
    });

    rows.push(file("b.md", 11));
    await waitFor(() => pushes.length === 1);
    expect(pushes[0].path).toBe("b.md");
    // a poll after the push started must not save past it either
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(await savedRank()).toBe(10);

    pushes[0].push.resolve();
    await waitFor(async () => (await savedRank()) === 11);
  });

  it("saves the position straight away on a first run, with nothing to push", async function () {
    await fs.remove(stateFile);
    rows.push(file("a.md", 7));
    const journal = await loadJournal();

    expect(await journal.openJournal()).toEqual([]);
    expect(await savedRank()).toBe(7);
  });
});
