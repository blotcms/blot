describe("scheduler sweep-git", function () {
  const sweepGit = require("../sweep-git");
  const stuckProcesses = require("clients/git/stuckProcesses");

  const CLEAN = {
    repositories: 2,
    removed: 0,
    bytes: 0,
    errors: 0,
    directories: [],
  };

  // `ps -eo pid=,etime=,rss=,args=` in the procps form
  const PS = [
    "    1  3-04:05:06  1780 /sbin/tini -- node app/index.js",
    "   40     1:05:09 30000 git-receive-pack /git/example.git",
    "   41  2:00:01   9000 git index-pack --stdin",
    "   42  1:59:59   9000 git-upload-pack /git/example.git",
    "   43  5-00:00:00 8000 node git-receive-pack-notes.js",
    "   44    10:00    500 git-upload-pack /git/example.git",
  ].join("\n");

  const run = async (options) => {
    const sent = [];

    const result = await sweepGit({
      sendEmail: async (view) => sent.push(view),
      sweep: async () => CLEAN,
      findStuck: async () => [],
      ...options,
    });

    return { sent, result };
  };

  it("finds git processes running for more than two hours", async function () {
    const stuck = await stuckProcesses({ ps: async () => PS });

    expect(stuck.map((p) => p.pid)).toEqual([41]);
    expect(stuck[0].seconds).toBe(7201);
    expect(stuck[0].rssKb).toBe(9000);
    expect(stuck[0].args).toBe("git index-pack --stdin");
  });

  // What the production container's busybox ps actually prints once a
  // process is over 100 minutes old, or uses a lot of memory
  it("reads busybox's hours, days and RSS suffixes", async function () {
    const stuck = await stuckProcesses({
      ps: async () =>
        [
          " 1355  2h15   2820 git-receive-pack --stateless-rpc /git/example.git",
          " 1357  2h15   503m /usr/libexec/git-core/git index-pack --stdin",
          " 1360  1h50   2828 git-receive-pack --stateless-rpc /git/example.git",
          " 1370  3d04   1g git-upload-pack /git/example.git",
        ].join("\n"),
    });

    expect(stuck.map((p) => [p.pid, p.seconds, p.rssKb])).toEqual([
      [1355, 8100, 2820],
      [1357, 8100, 503 * 1024],
      [1370, 3 * 86400 + 4 * 3600, 1024 * 1024],
    ]);
  });

  it("sends nothing when nothing is wrong", async function () {
    const { sent, result } = await run({
      findStuck: () => stuckProcesses({ ps: async () => "1  0:05  100 node" }),
    });

    expect(sent).toEqual([]);
    expect(result.sent).toBe(false);
  });

  it("sends one email when git processes are stuck", async function () {
    const { sent, result } = await run({
      findStuck: () => stuckProcesses({ ps: async () => PS }),
    });

    expect(result.sent).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0].summary).toBe("1 stuck git process");
    expect(sent[0].stuck).toEqual([
      { pid: 41, age: "2h 0m", rss: "8.8 MB", args: "git index-pack --stdin" },
    ]);
  });

  it("sends an email when directories were removed or the sweep had errors", async function () {
    const removed = await run({
      sweep: async () => ({
        ...CLEAN,
        removed: 1,
        bytes: 3 * 1024 * 1024,
        directories: [
          { repository: "example.git", bytes: 3 * 1024 * 1024, ageMs: 3 * 24 * 3600 * 1000 },
        ],
      }),
    });

    expect(removed.sent[0].removed).toEqual([
      { repository: "example.git", size: "3.0 MB", age: "3 days" },
    ]);

    const failed = await run({ sweep: async () => ({ ...CLEAN, errors: 2 }) });

    expect(failed.sent[0].summary).toBe("2 sweep errors");
  });
});
