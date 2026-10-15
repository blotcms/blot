describe("templates startup build locks", function () {
  const lock = require("helper/lock");
  const fsExtra = require("fs-extra");
  const Template = require("models/template");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  describe("templates()", function () {
    let originalReaddirSync;
    let originalGetTemplateList;
    let getTemplateList;

    beforeEach(function () {
      originalReaddirSync = fsExtra.readdirSync;
      originalGetTemplateList = Template.getTemplateList;

      // No template directories, so the pass is a no-op that still reaches
      // checkForExtinctTemplates (which lists templates once per pass).
      fsExtra.readdirSync = () => [];
      getTemplateList = jasmine
        .createSpy("getTemplateList")
        .and.callFake((_owner, callback) => callback(null, []));
      Template.getTemplateList = getTemplateList;
    });

    afterEach(function () {
      fsExtra.readdirSync = originalReaddirSync;
      Template.getTemplateList = originalGetTemplateList;
    });

    const run = (templates) =>
      new Promise((resolve, reject) =>
        templates({}, (err) => (err ? reject(err) : resolve()))
      );

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
    it("passes a synchronous build error to the callback once", async function () {
      const templates = require("templates");
      const original = fsExtra.readdirSync;
      fsExtra.readdirSync = () => {
        throw new Error("cannot read directory");
      };
      let calls = 0;

      try {
        const err = await new Promise((resolve) =>
          templates({}, (e) => {
            calls++;
            resolve(e);
          })
        );
        await sleep(50);
        expect(err && err.message).toBe("cannot read directory");
        expect(calls).toBe(1);
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
      setupUser = jasmine
        .createSpy("setupUser")
        .and.callFake(async () => {
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
