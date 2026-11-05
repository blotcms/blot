// The fallback's transfer when the feed into git fails: the failure is
// handled at once, so a feed that fails before git has closed is never an
// unhandled rejection (app/index.js rethrows those, and the process would go
// down), and the fallback rejects cleanly. No Redis, no blog: just git and a
// store that fails.
describe("git store served: the fallback's feed into git", function () {
  const fs = require("fs-extra");
  const os = require("os");
  const path = require("path");
  const { execFileSync } = require("child_process");
  const fallback = require("clients/git/served/fallback");
  const { createMemoryStore, createCache, manifest } = require("clients/git/store");
  const importRepo = require("clients/git/store/import");

  let dir;
  let unhandled;

  function onUnhandled(err) {
    unhandled.push(err);
  }

  const run = (cwd, args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fallback-feed-"));
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(function () {
    process.removeListener("unhandledRejection", onUnhandled);
    fs.removeSync(dir);
  });

  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  it("reports a feed which fails long before git closes, without an unhandled rejection", async function () {
    const gitDir = path.join(dir, "repo.git");
    run(dir, ["init", "-q", "--bare", gitDir]);

    const result = await fallback._git(gitDir, ["-c", "alias.slow=!sleep 0.5", "slow"], {
      stdin: () => Promise.reject(new Error("the store read failed")),
    });

    await settle();
    expect(unhandled).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.fedError.message).toBe("the store read failed");
  });

  it("reports a feed which throws as it starts", async function () {
    const gitDir = path.join(dir, "repo.git");
    run(dir, ["init", "-q", "--bare", gitDir]);

    const result = await fallback._git(gitDir, ["-c", "alias.slow=!sleep 0.2", "slow"], {
      stdin: () => {
        throw new Error("no stream");
      },
    });

    await settle();
    expect(unhandled).toEqual([]);
    expect(result.fedError.message).toBe("no stream");
  });

  it("rejects the transfer cleanly when the store fails part way, leaving no quarantine", async function () {
    const src = path.join(dir, "src");
    fs.ensureDirSync(src);
    run(src, ["init", "-q", "-b", "master"]);
    run(src, ["config", "user.email", "spec@example.com"]);
    run(src, ["config", "user.name", "Spec"]);
    fs.writeFileSync(path.join(src, "a.txt"), "A");
    run(src, ["add", "-A"]);
    run(src, ["commit", "-qm", "one"]);
    const one = run(src, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(src, "b.bin"), require("crypto").randomBytes(256 * 1024));
    run(src, ["add", "-A"]);
    run(src, ["commit", "-qm", "two"]);
    const two = run(src, ["rev-parse", "HEAD"]);

    const full = path.join(dir, "full.git");
    run(dir, ["clone", "-q", "--bare", src, full]);

    const store = createMemoryStore();
    const cache = createCache({ dir: path.join(dir, "cache"), maxBytes: 64 * 1024 * 1024 });
    await importRepo({ store, cache, lock: (fn) => fn(), gitDir: full });
    const current = await manifest.read(store);

    // Every read of a pack fails from now on
    const failing = new Proxy(store, {
      get(target, name) {
        const value = target[name];
        if (typeof value !== "function") return value;
        return () => Promise.reject(new Error("the store is down"));
      },
    });
    const cold = createCache({ dir: path.join(dir, "cold"), maxBytes: 64 * 1024 * 1024 });

    const ebs = path.join(dir, "ebs.git");
    run(dir, ["init", "-q", "--bare", ebs]);
    run(ebs, ["fetch", "-q", src, one + ":refs/heads/master"]);

    const failed = await fallback._fetchInto(ebs, { store: failing, cache: cold, current, wants: [two], haves: [one] }).then(
      () => null,
      (err) => err
    );

    await settle();
    expect(failed).not.toBe(null);
    expect(unhandled).toEqual([]);
    expect(fs.readdirSync(path.join(ebs, "objects")).filter((name) => name.indexOf("tmp_objdir-incoming-") === 0)).toEqual([]);
    expect(run(ebs, ["rev-parse", "master"])).toBe(one);
  });
});
