describe("update", function () {
  var sync = require("../index");
  var folder = require("storage/folder");
  var build = require("build");

  // Runs fn(syncFolder) while holding the blog's sync lock, then releases it.
  // Resolves to what fn resolves to.
  function withSync(blogID, fn) {
    return new Promise(function (resolve, reject) {
      sync(blogID, function (err, syncFolder, done) {
        if (err) return reject(err);

        Promise.resolve()
          .then(function () {
            return fn(syncFolder);
          })
          .then(
            function (value) {
              done(null, function () {
                resolve(value);
              });
            },
            function (error) {
              done(null, function () {
                reject(error);
              });
            }
          );
      });
    });
  }

  function update(syncFolder, path) {
    return new Promise(function (resolve, reject) {
      syncFolder.update(path, function (err, result) {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  function checkEntry(check, spec) {
    return new Promise(function (resolve, reject) {
      check(spec, function (err) {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  function getEntry(blogID, path) {
    const Entry = require("models/entry");
    return new Promise(function (resolve) {
      Entry.get(blogID, path, resolve);
    });
  }

  // The "rebuilds an entry if the source file changes" spec below writes
  // the source file every 10ms for ~3 seconds while sync.update recurses
  // to catch up (see app/sync/update/index.js), so it can legitimately take
  // longer than Jasmine's 5 second default under load, causing an
  // intermittent timeout (and a stray late failure attributed to whichever
  // spec runs next).
  global.test.timeout(15 * 1000);

  // Set up a test blog before each test
  global.test.blog();

  // Expose methods for creating fake files, paths, etc.
  beforeEach(function () {
    this.fake = global.test.fake;
  });

  beforeEach(function () {
    this.checkEntry = global.test.CheckEntry(this.blog.id);
  });

  it("rebuilds an entry if the source file changes", async function () {
    const path = this.fake.path(".txt");
    const blogID = this.blog.id;
    const check = this.checkEntry;
    let content = 1;
    let written = 1;
    let writes = Promise.resolve();

    await withSync(blogID, async function (syncFolder) {
      await folder.write(blogID, path, content.toString());

      // The writes are queued one after another so they land in order
      const poll = setInterval(function () {
        content = content + 1;
        const value = content;
        writes = writes.then(async function () {
          await folder.write(blogID, path, value.toString());
          written = value;
        });
        if (content > 300) clearInterval(poll);
      }, 10);

      let seen;

      try {
        await update(syncFolder, path);
        // Stop the background writes as soon as update() has read the file.
        // Left running, this interval can keep writing into the blog's
        // folder well past this test's own completion.
        seen = written;
      } finally {
        clearInterval(poll);
        await writes;
      }

      await checkEntry(check, { path: path, html: `<p>${seen}</p>` });
    });
  });

  it("creates an entry from a new file", async function () {
    const path = this.fake.path(".txt");
    const content = this.fake.file();
    const blogID = this.blog.id;
    const check = this.checkEntry;

    await withSync(blogID, async function (syncFolder) {
      await folder.write(blogID, path, content);
      await update(syncFolder, path);
      await checkEntry(check, { path: path });
    });
  });

  it("deletes an entry when you remove the file", async function () {
    const path = this.fake.path(".txt");
    const content = this.fake.file();
    const blogID = this.blog.id;
    const check = this.checkEntry;

    await withSync(blogID, async function (syncFolder) {
      await folder.write(blogID, path, content);
      await update(syncFolder, path);
      await checkEntry(check, { path: path, deleted: false });

      await folder.remove(blogID, path);
      await update(syncFolder, path);
      await checkEntry(check, { path: path, deleted: true });
    });
  });

  it("re-syncs a file that changed while it was being processed", async function () {
    const Entry = require("models/entry");
    const path = this.fake.path(".txt");
    const blogID = this.blog.id;
    const original = Entry.set;
    let calls = 0;
    let changed = Promise.resolve();

    await withSync(blogID, async function (syncFolder) {
      spyOn(Entry, "set").and.callFake(function (blogID, entryPath, entry, cb) {
        // Change the source (and its size) after the first build read it. The
        // write is finished before the entry is saved.
        if (++calls === 1) changed = folder.write(blogID, path, "second version");
        changed.then(function () {
          original.call(Entry, blogID, entryPath, entry, cb);
        }, cb);
      });

      await folder.write(blogID, path, "first");

      const result = await update(syncFolder, path);
      expect(result.error).toBeNull();
      expect(calls).toBe(2);

      const entry = await getEntry(blogID, path);
      expect(entry.html).toContain("second version");
    });
  });

  it("does not re-sync a directory", async function () {
    const dir = "/some-folder";
    const blogID = this.blog.id;

    await withSync(blogID, async function (syncFolder) {
      await folder.mkdir(blogID, dir);

      // A directory has no fingerprint, so a build which touches it must not
      // re-run the update.
      const touch = spyOn(build, "findMultiFolder").and.callFake(function () {
        return null;
      });

      const result = await update(syncFolder, dir);
      expect(result.error).toBeNull();
      expect(touch.calls.count()).toBe(1);
    });
  });

  it("ignores oversized sources, removes their entries, and recovers after shrinking", async function () {
    const IgnoredFiles = require("models/ignoredFiles");
    const limit = require("build/converters/post-source-size").MARKDOWN.bytes;
    const entryPath = "/size-limit.md";
    const blogID = this.blog.id;

    const status = function () {
      return new Promise(function (resolve, reject) {
        IgnoredFiles.getStatus(blogID, entryPath, function (err, reason) {
          if (err) return reject(err);
          resolve(reason);
        });
      });
    };

    await withSync(blogID, async function (syncFolder) {
      await folder.write(blogID, entryPath, "published");
      await update(syncFolder, entryPath);

      await folder.write(blogID, entryPath, Buffer.alloc(limit + 1, 32));
      await update(syncFolder, entryPath);

      expect(await status()).toBe("TOO_LARGE");

      let entry = await getEntry(blogID, entryPath);
      // Entry.drop leaves a deleted tombstone rather than removing
      // the record outright.
      expect(entry).toBeTruthy();
      expect(entry.deleted).toBe(true);

      await folder.write(blogID, entryPath, "published again");
      await update(syncFolder, entryPath);

      expect(await status()).toBeFalsy();
      entry = await getEntry(blogID, entryPath);
      expect(entry).toBeTruthy();
      expect(entry.html).toContain("published again");
    });
  });

  it("drops the entry of a file which is gone", async function () {
    const entryPath = "/gone.txt";
    const blogID = this.blog.id;

    await withSync(blogID, async function (syncFolder) {
      await folder.write(blogID, entryPath, "Title: Gone");
      await update(syncFolder, entryPath);

      await folder.remove(blogID, entryPath);
      await update(syncFolder, entryPath);

      const entry = await getEntry(blogID, entryPath);
      expect(!entry || entry.deleted).toBeTruthy();
    });
  });
});
