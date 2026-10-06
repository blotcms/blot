const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const config = require("config");
const build = require("documentation/build");
const recursiveReadDir = require("helper/recursiveReadDirSync");

describe("Blot's documentation'", function () {

  global.test.site();
  global.test.timeout(5 * 60 * 1000); // Set timeout to 5 minutes

  it("has no broken links", async function () {
    await this.checkBrokenLinks();
  });

  it("refreshes generated tool pages after restoring a stale cache", async function () {
    const toolName = "__documentation-cache-startup-test";
    const sourcePath = path.join(
      config.blot_directory,
      "app/views/how/tools/text-editors",
      toolName + ".html"
    );
    const generatedPath = path.join(
      config.views_directory,
      "how/tools",
      toolName,
      "index.html"
    );
    const originalTmpDirectory = config.tmp_directory;
    const tmpDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "blot-documentation-cache-")
    );

    config.tmp_directory = tmpDirectory;

    try {
      await fs.outputFile(sourcePath, "<h1>Cache Startup Test Tool</h1>");
      await fs.remove(generatedPath);

      const hash = await build.computeViewsHash();
      const cacheDirectory = path.join(
        tmpDirectory,
        "documentation-cache",
        hash,
        "views-built"
      );

      // Deliberately put the pre-tool-build output under the current hash.
      // This models a stale/incomplete cache that a startup must not trust.
      await fs.copy(config.views_directory, cacheDirectory);

      await build({ watch: false });

      const generated = await fs.readFile(generatedPath, "utf8");
      expect(generated).toContain("Cache Startup Test Tool");

      const refreshedCachePath = path.join(
        tmpDirectory,
        "documentation-cache",
        await build.computeViewsHash(),
        "views-built",
        "how/tools",
        toolName,
        "index.html"
      );

      expect(await fs.pathExists(refreshedCachePath)).toBe(true);
      expect(await fs.readFile(refreshedCachePath, "utf8")).toContain(
        "Cache Startup Test Tool"
      );
    } finally {
      await fs.remove(sourcePath);
      await fs.remove(generatedPath);
      try {
        await build.rebuildTools();
      } finally {
        config.tmp_directory = originalTmpDirectory;
        await fs.remove(tmpDirectory);
      }
    }
  });

  it("includes app/templates/source in computeViewsHash", async function () {
    const readmePath = path.join(
      config.blot_directory,
      "app/templates/source/text/README"
    );
    const original = await fs.readFile(readmePath, "utf8");

    try {
      const before = await build.computeViewsHash();

      await fs.outputFile(readmePath, original + "\n<!-- hash test -->\n");

      const after = await build.computeViewsHash();

      // templates.js reads app/templates/source (see loadTemplates), so a
      // change there must change the fingerprint used to decide whether an
      // existing dev cache is still valid. If this doesn't hold, a stale
      // cache gets restored on top of the change on the next build.
      expect(after).not.toEqual(before);
    } finally {
      await fs.outputFile(readmePath, original);
    }
  });

  it("rebuilds template pages instead of restoring a stale cache when template source changes", async function () {
    const readmePath = path.join(
      config.blot_directory,
      "app/templates/source/text/README"
    );
    const generatedPath = path.join(
      config.views_directory,
      "templates/text/index.html"
    );
    const original = await fs.readFile(readmePath, "utf8");
    const originalTmpDirectory = config.tmp_directory;
    const tmpDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "blot-documentation-cache-")
    );

    config.tmp_directory = tmpDirectory;

    try {
      // Populate a cache entry for the current (unmodified) source.
      await build({ watch: false, skipZip: true });

      // Change an input that only templates.js reads. This models editing
      // a template's README, or running templates.js directly for fast
      // local iteration (a documented pattern) - either way, the change
      // must survive the next full build rather than being reverted by a
      // cache restore keyed on a fingerprint that never noticed it.
      await fs.outputFile(readmePath, original + "\nMARKER_README_CHANGE\n");

      await build({ watch: false, skipZip: true });

      expect(await fs.readFile(generatedPath, "utf8")).toContain(
        "MARKER_README_CHANGE"
      );
    } finally {
      await fs.outputFile(readmePath, original);
      try {
        await build({ watch: false, skipZip: true });
      } finally {
        config.tmp_directory = originalTmpDirectory;
        await fs.remove(tmpDirectory);
      }
    }
  });

  it("copies arbitrary template views into views-built", async function () {
    const probeName = "__live-view-probe.html";
    const probeContents = "LIVE_VIEW_PROBE\n{{mustache-stays}}\n";
    const sourceDirectory = path.join(
      config.blot_directory,
      "app/views/templates"
    );
    const probeSource = path.join(sourceDirectory, probeName);
    const probeBuilt = path.join(
      config.views_directory,
      "templates",
      probeName
    );
    const originalTmpDirectory = config.tmp_directory;
    const tmpDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "blot-documentation-cache-")
    );

    config.tmp_directory = tmpDirectory;

    try {
      await fs.outputFile(probeSource, probeContents);
      await fs.remove(probeBuilt);

      await build({ watch: false, skipZip: true });

      // build/index.js skips templates/ in the generic copy and leaves
      // publication to build/templates.js. That step has to carry every
      // source file it does not bake, or a new live view 404s with no error.
      expect(await fs.readFile(probeBuilt, "utf8")).toEqual(probeContents);

      for (const name of ["fonts.html", "search.html", "template-list.html"]) {
        const source = await fs.readFile(path.join(sourceDirectory, name), "utf8");
        const built = await fs.readFile(
          path.join(config.views_directory, "templates", name),
          "utf8"
        );
        expect(built).toEqual(source);
      }

      // index.html is baked. Copying the raw source over the published page
      // would drop the build-time template data until renderView finishes.
      const indexSource = await fs.readFile(
        path.join(sourceDirectory, "index.html"),
        "utf8"
      );
      const indexBuilt = await fs.readFile(
        path.join(config.views_directory, "templates/index.html"),
        "utf8"
      );
      expect(indexBuilt).not.toEqual(indexSource);

      await fs.remove(probeSource);
      await build({ watch: false, skipZip: true });

      expect(await fs.pathExists(probeBuilt)).toBe(false);
      const cachedProbe = path.join(
        tmpDirectory,
        "documentation-cache",
        await build.computeViewsHash(),
        "views-built",
        "templates",
        probeName
      );
      expect(await fs.pathExists(cachedProbe)).toBe(false);
    } finally {
      await fs.remove(probeSource);
      await fs.remove(probeBuilt);
      config.tmp_directory = originalTmpDirectory;
      await fs.remove(tmpDirectory);
    }
  });

  it("overlapping builds do not crash or corrupt the cache", async function () {
    const originalTmpDirectory = config.tmp_directory;
    const tmpDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "blot-documentation-cache-")
    );

    config.tmp_directory = tmpDirectory;

    const snapshot = (dir) =>
      recursiveReadDir(dir)
        .map((file) => {
          const stat = fs.statSync(file);
          return file.slice(dir.length + 1) + ":" + stat.size;
        })
        .sort();

    const cacheSnapshot = async () => {
      const cacheDir = path.join(
        tmpDirectory,
        "documentation-cache",
        await build.computeViewsHash(),
        "views-built"
      );
      expect(await fs.pathExists(cacheDir)).toBe(true);
      expect(snapshot(cacheDir)).toEqual(snapshot(config.views_directory));
    };

    const runChildBuild = () =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "-e",
            "const config = require('config');" +
              "config.tmp_directory = " +
              JSON.stringify(tmpDirectory) +
              ";" +
              "require('documentation/build')({ watch: false, skipZip: true })" +
              ".then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });",
          ],
          {
            cwd: config.blot_directory,
            env: {
              ...process.env,
              NODE_PATH:
                process.env.NODE_PATH ||
                path.join(config.blot_directory, "app"),
            },
          }
        );
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          output += chunk;
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error("child build exited " + code + "\n" + output));
        });
      });

    try {
      // A lock left by a dead process must not wedge the next build.
      let deadPid = null;
      for (let pid = 200000; pid < 900000; pid += 997) {
        try {
          process.kill(pid, 0);
        } catch (err) {
          if (err.code === "ESRCH") {
            deadPid = pid;
            break;
          }
        }
      }
      const lockPath = path.join(tmpDirectory, "documentation-build.lock");
      await fs.ensureDir(lockPath);
      await fs.writeFile(path.join(lockPath, "pid"), String(deadPid));
      const past = new Date(Date.now() - 60 * 1000);
      await fs.utimes(lockPath, past, past);

      const overlapped = await Promise.allSettled([
        build({ watch: false, skipZip: true }),
        build({ watch: false, skipZip: true }),
      ]);
      const rejected = overlapped.filter((result) => result.status === "rejected");
      if (rejected.length) throw rejected[0].reason;

      await cacheSnapshot();

      // A second process (nodemon restart, or a manual build while the
      // server is rebuilding) shares the cache directory and used to hit
      // ENOTEMPTY inside fs.rm while the other build was still copying.
      await Promise.all([runChildBuild(), runChildBuild()]);
      await cacheSnapshot();
    } finally {
      config.tmp_directory = originalTmpDirectory;
      await fs.remove(tmpDirectory);
    }
  });

  it("reclaims a documentation build lock whose pid was reused", async function () {
    const originalTmpDirectory = config.tmp_directory;
    const tmpDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "blot-documentation-cache-")
    );

    config.tmp_directory = tmpDirectory;

    try {
      // Same pid as this process, but not this process's start time. A pid-only
      // check would treat the lock as live and wait out the ten-minute timeout.
      const lockPath = path.join(tmpDirectory, "documentation-build.lock");
      await fs.ensureDir(lockPath);
      await fs.writeFile(path.join(lockPath, "pid"), process.pid + ":bogus-start");
      const past = new Date(Date.now() - 60 * 1000);
      await fs.utimes(lockPath, past, past);

      const started = Date.now();
      await build({ watch: false, skipZip: true });
      expect(Date.now() - started).toBeLessThan(60 * 1000);
    } finally {
      config.tmp_directory = originalTmpDirectory;
      await fs.remove(tmpDirectory);
    }
  });

  it("coalesces watcher paths into one rebuild batch", async function () {
    const batches = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const enqueue = build.createWatchQueue(async (batch) => {
      batches.push(batch.slice());
      if (batches.length === 1) await gate;
    });

    const first = enqueue("a.html");
    enqueue("b.html");
    enqueue("c.html");
    enqueue("a.html");
    release();
    await first;

    expect(batches.length).toBeGreaterThan(0);
    expect(batches.length).toBeLessThan(4);
    const flat = [].concat(...batches);
    expect(flat).toContain("a.html");
    expect(flat).toContain("b.html");
    expect(flat).toContain("c.html");
    expect(batches[batches.length - 1].sort()).toEqual(["a.html", "b.html", "c.html"]);
  });

  it("updates changed tool pages and refreshes their cache", async function () {
    const toolName = "__documentation-cache-change-test";
    const sourcePath = path.join(
      config.blot_directory,
      "app/views/how/tools/text-editors",
      toolName + ".html"
    );
    const generatedPath = path.join(
      config.views_directory,
      "how/tools",
      toolName,
      "index.html"
    );
    const originalTmpDirectory = config.tmp_directory;
    const tmpDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "blot-documentation-cache-")
    );

    config.tmp_directory = tmpDirectory;

    try {
      await fs.outputFile(sourcePath, "<h1>Cache Change Test Tool</h1>");
      await build.rebuildTools();

      await fs.outputFile(
        sourcePath,
        "<h1>Updated Cache Change Test Tool</h1>"
      );
      await build.rebuildTools();

      expect(await fs.readFile(generatedPath, "utf8")).toContain(
        "Updated Cache Change Test Tool"
      );

      const refreshedCachePath = path.join(
        tmpDirectory,
        "documentation-cache",
        await build.computeViewsHash(),
        "views-built",
        "how/tools",
        toolName,
        "index.html"
      );

      expect(await fs.readFile(refreshedCachePath, "utf8")).toContain(
        "Updated Cache Change Test Tool"
      );
    } finally {
      await fs.remove(sourcePath);
      await fs.remove(generatedPath);
      try {
        await build.rebuildTools();
      } finally {
        config.tmp_directory = originalTmpDirectory;
        await fs.remove(tmpDirectory);
      }
    }
  });
});
