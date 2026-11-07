describe("templates startup build locks", function () {
  const lock = require("helper/lock");
  const fsExtra = require("fs-extra");
  const Template = require("models/template");
  const { dirname, resolve } = require("path");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // fs-extra is shared by the whole process (the documentation watcher and
  // build read directories too), so only fake reads of the templates source.
  const SOURCE = resolve(dirname(require.resolve("templates")), "source");
  const fakeSourceReaddir = (original, fake) =>
    function (directory) {
      if (resolve(String(directory)) !== SOURCE)
        return original.apply(this, arguments);
      return fake();
    };

  describe("templates()", function () {
    let originalReaddirSync;
    let originalGetTemplateList;
    let getTemplateList;

    beforeEach(function () {
      originalReaddirSync = fsExtra.readdirSync;
      originalGetTemplateList = Template.getTemplateList;

      // No template directories, so the pass is a no-op that still reaches
      // checkForExtinctTemplates (which lists templates once per pass).
      fsExtra.readdirSync = fakeSourceReaddir(originalReaddirSync, () => []);
      getTemplateList = jasmine
        .createSpy("getTemplateList")
        .and.callFake(async () => []);
      Template.getTemplateList = getTemplateList;
    });

    afterEach(function () {
      fsExtra.readdirSync = originalReaddirSync;
      Template.getTemplateList = originalGetTemplateList;
    });

    const run = (templates) => templates({});

    it("waits for a held build lock, then runs the pass", async function () {
      const templates = require("templates");
      const held = await lock("templates:build", { ttl: 10000 });
      let finished = false;
      const pass = run(templates).then(() => (finished = true));

      await sleep(300);
      expect(finished).toBe(false);
      expect(getTemplateList).not.toHaveBeenCalled();

      await held.release();
      await pass;

      expect(finished).toBe(true);
      expect(getTemplateList).toHaveBeenCalledTimes(1);
    });

    it("serialises concurrent passes and releases the lock", async function () {
      const templates = require("templates");

      await Promise.all([run(templates), run(templates)]);
      expect(getTemplateList).toHaveBeenCalledTimes(2);

      // Nothing left held: acquiring with no retries succeeds.
      const again = await lock("templates:build", { ttl: 10000 });
      await again.release();
    });
  });

  describe("buildPass failures", function () {
    it("rejects once with a synchronous build error", async function () {
      const templates = require("templates");
      const original = fsExtra.readdirSync;
      fsExtra.readdirSync = fakeSourceReaddir(original, () => {
        throw new Error("cannot read directory");
      });

      try {
        try {
          await templates({});
          fail("expected the build to reject");
        } catch (err) {
          expect(err.message).toBe("cannot read directory");
        }
      } finally {
        fsExtra.readdirSync = original;
      }

      // The lock was released despite the throw.
      const again = await lock("templates:build", { ttl: 10000 });
      await again.release();
    });
  });

  describe("folders()", function () {
    const foldersPath = require.resolve("templates/folders");
    const setupUserPath = require.resolve("templates/folders/setupUser");
    let originalFolders;
    let originalSetupUser;
    let setupUser;

    beforeEach(function () {
      originalFolders = require.cache[foldersPath];
      originalSetupUser = require.cache[setupUserPath];
      setupUser = jasmine.createSpy("setupUser").and.callFake(async () => {
        throw new Error("should not run");
      });
      require.cache[setupUserPath] = {
        id: setupUserPath,
        filename: setupUserPath,
        loaded: true,
        exports: setupUser,
      };
      delete require.cache[foldersPath];
    });

    afterEach(function () {
      delete require.cache[foldersPath];
      if (originalFolders) require.cache[foldersPath] = originalFolders;
      if (originalSetupUser) require.cache[setupUserPath] = originalSetupUser;
      else delete require.cache[setupUserPath];
    });

    it("waits for a held lock, then runs", async function () {
      const folders = require("templates/folders");
      const held = await lock("templates:folders", { ttl: 10000 });
      let released = false;

      try {
        const run = folders().catch(() => {});
        await sleep(300);
        expect(setupUser).not.toHaveBeenCalled();

        await held.release();
        released = true;
        await run;
        expect(setupUser).toHaveBeenCalled();
      } finally {
        if (!released) await held.release();
      }
    });
  });
});
