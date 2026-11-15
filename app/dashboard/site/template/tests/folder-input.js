describe("folder_root control", function () {
  const folder = require("storage/folder");
  const folderInput = require("../load/folder-input");
  const indexInputs = require("../load/index-inputs");
  const folderList = require("../load/folder-list");
  const folderRootSave = require("../save/folder-root");
  const folderRoot = require("../load/util/folder-root");

  // A blog folder with /Posts, /Posts/2024 and a file called /about.txt
  function fakeFolder() {
    const dirs = { "/Posts": ["2024", ".hidden"], "/Posts/2024": [] };

    spyOn(folder, "resolveCaseInsensitive").and.callFake(
      async (blogID, path) => {
        const found = Object.keys(dirs)
          .concat(["/about.txt"])
          .find((key) => key.toLowerCase() === path.toLowerCase());
        if (!found) throw new folder.NotFoundError("No path: " + path);
        return found;
      }
    );
    spyOn(folder, "stat").and.callFake(async (blogID, path) => ({
      isDirectory: path in dirs,
    }));
    spyOn(folder, "list").and.callFake(async (blogID, dir) => ({
      entries: dirs[dir].map((name) => ({ name, isDirectory: true })),
      cursor: null,
    }));
  }

  async function load(locals) {
    const req = { blog: { id: "blog_1" }, template: { locals } };
    const res = { locals: {} };
    const next = jasmine.createSpy("next");

    await folderInput(req, res, next);

    expect(next).toHaveBeenCalledWith();
    return res.locals.folder_root_control;
  }

  beforeEach(fakeFolder);

  it("shows a control for folder_root", async function () {
    const control = await load({ folder_root: "/Posts" });

    expect(control.key).toBe("folder_root");
    expect(control.label).toBe("Folder");
    expect(control.value).toBe("/Posts");
    expect(control.error).toBe(null);
  });

  it("has no control, and no generic input, for demo_folder", async function () {
    const locals = { demo_folder: "notes", page_size: 10 };

    expect(await load(locals)).toBe(null);

    const res = { locals: {} };
    indexInputs({ template: { locals } }, res, () => {});
    expect(res.locals.index_page.map((input) => input.key)).toEqual([
      "page_size",
    ]);
  });

  it("has no control for a key which only ends in _folder", async function () {
    expect(await load({ photos_folder: "/Posts" })).toBe(null);
  });

  it("does not render folder_root as a generic input", function () {
    const res = { locals: {} };
    indexInputs(
      {
        template: {
          locals: { folder_root: "/Posts", folder_root_options: ["/Posts"] },
        },
      },
      res,
      () => {}
    );

    expect(res.locals.index_page).toEqual([]);
  });

  it("treats an empty value as the default folder", async function () {
    expect((await load({ folder_root: "" })).error).toBe(null);
    expect(folder.resolveCaseInsensitive).toHaveBeenCalledWith(
      "blog_1",
      "/Posts"
    );
  });

  it("flags a folder which doesn't exist", async function () {
    expect((await load({ folder_root: "/Photos" })).error).toBe(
      "This folder doesn't exist"
    );
  });

  it("flags a path which is a file, not a directory", async function () {
    expect((await load({ folder_root: "/about.txt" })).error).toBe(
      "This folder doesn't exist"
    );
  });

  it("flags a path with a .. segment without reading storage", async function () {
    const control = await load({ folder_root: "/Posts/../secret" });

    expect(control.error).toBeTruthy();
    expect(folder.stat).not.toHaveBeenCalled();
  });

  it("ignores case, as the matcher does", async function () {
    expect((await load({ folder_root: "/posts/2024/" })).error).toBe(null);
  });

  it("shows the control without an error when storage fails", async function () {
    spyOn(console, "log");
    folder.resolveCaseInsensitive.and.callFake(async () => {
      throw new Error("S3 is down");
    });

    expect((await load({ folder_root: "/Posts" })).error).toBe(null);
  });

  describe("normalize", function () {
    it("adds a leading slash and drops the trailing one", function () {
      expect(folderRoot.normalize("Posts/")).toBe("/Posts");
      expect(folderRoot.normalize("//Posts//2024/")).toBe("/Posts/2024");
      expect(folderRoot.normalize("/Posts/./2024")).toBe("/Posts/2024");
      expect(folderRoot.normalize("/")).toBe("/");
    });

    it("refuses .. and non-strings", function () {
      expect(folderRoot.normalize("/a/../b")).toBe(null);
      expect(folderRoot.normalize("..")).toBe(null);
      expect(folderRoot.normalize("/a\\..\\b")).toBe(null);
      expect(folderRoot.normalize("/a/\u0000")).toBe(null);
      expect(folderRoot.normalize(undefined)).toBe(null);
      expect(folderRoot.normalize({})).toBe(null);
    });

    it("keeps names which only contain dots", function () {
      expect(folderRoot.normalize("/a..b/...")).toBe("/a..b/...");
    });
  });

  describe("save", function () {
    function save(submitted, query) {
      const req = {
        query: query || {},
        baseUrl: "/sites/x/template",
        url: "/default",
        body: submitted,
        locals: { folder_root: "/Posts", page_size: 10 },
      };
      const res = {
        message: jasmine.createSpy("message"),
        status: jasmine.createSpy("status").and.callFake(() => res),
        set: jasmine.createSpy("set").and.callFake(() => res),
        json: jasmine.createSpy("json"),
      };
      const next = jasmine.createSpy("next");

      folderRootSave(req, res, next);

      return { req, res, next };
    }

    it("saves a normalised path", function () {
      const { req, next } = save({ "locals.folder_root": "Photos/2024/" });

      expect(next).toHaveBeenCalledWith();
      expect(req.locals.folder_root).toBe("/Photos/2024");
    });

    it("saves a folder which doesn't exist", function () {
      const { req, next } = save({ locals: { folder_root: "/Later" } });

      expect(next).toHaveBeenCalledWith();
      expect(req.locals.folder_root).toBe("/Later");
    });

    it("keeps an empty value, which means the default", function () {
      const { req } = save({ "locals.folder_root": "  " });

      expect(req.locals.folder_root).toBe("");
    });

    it("leaves other saves alone", function () {
      const { req, next } = save({ "locals.page_size": "20" });

      expect(next).toHaveBeenCalledWith();
      expect(req.locals.folder_root).toBe("/Posts");
    });

    it("refuses .. with a 400 for an ajax save", function () {
      const { req, res, next } = save(
        { "locals.folder_root": "/Posts/../x" },
        { ajax: "true" }
      );

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: "A folder can't contain ..",
      });
      expect(req.locals.folder_root).toBe("/Posts");
    });

    it("refuses .. with a message for a form post", function () {
      const { res, next } = save({ "locals.folder_root": ".." });

      expect(next).not.toHaveBeenCalled();
      expect(res.message).toHaveBeenCalled();
    });
  });

  describe("folder list route", function () {
    async function list(query) {
      const req = { blog: { id: "blog_1" }, query };
      const res = {
        set: jasmine.createSpy("set"),
        status: jasmine.createSpy("status").and.callFake(() => res),
        json: jasmine.createSpy("json"),
      };
      const next = jasmine.createSpy("next");

      await folderList(req, res, next);

      return { res, next };
    }

    it("lists the directories one level down, without dotfiles", async function () {
      const { res } = await list({ path: "/Posts/" });

      expect(res.json).toHaveBeenCalledWith({
        path: "/Posts",
        exists: true,
        directories: ["2024"],
      });
    });

    it("answers for a folder which doesn't exist", async function () {
      const { res } = await list({ path: "/Nope" });

      expect(res.json).toHaveBeenCalledWith({
        path: "/Nope",
        exists: false,
        directories: [],
      });
      expect(folder.list).not.toHaveBeenCalled();
    });

    it("refuses ..", async function () {
      const { res } = await list({ path: "/Posts/../.." });

      expect(res.status).toHaveBeenCalledWith(400);
      expect(folder.resolveCaseInsensitive).not.toHaveBeenCalled();
    });

    it("lists the root without a lookup", async function () {
      folder.list.and.callFake(async () => ({
        entries: [
          { name: "Posts", isDirectory: true },
          { name: "a.txt", isDirectory: false },
        ],
        cursor: null,
      }));

      const { res } = await list({});

      expect(res.json).toHaveBeenCalledWith({
        path: "/",
        exists: true,
        directories: ["Posts"],
      });
    });
  });
});
