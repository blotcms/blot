const config = require("config");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { randomUUID } = require("crypto");

describe("dashboard folder symbolic links", function () {
  let dir, blogID, blog, target, done, updated;
  beforeEach(async function () {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "blot-folder-links-"));
    // storage/folder reads the real config, so the blog lives in the real
    // blog folder directory
    blogID = "blog_" + randomUUID();
    blog = path.join(config.blog_folder_dir, blogID);
    target = path.join(dir, "target");
    await fs.ensureDir(blog);
    await fs.ensureDir(target);
    await fs.writeFile(path.join(target, "file.txt"), "original");
    await fs.symlink(target, path.join(blog, "ancestor"));
    done = jasmine.createSpy("release lock").and.returnValue(Promise.resolve());
    updated = jasmine.createSpy("update").and.returnValue(Promise.resolve());
  });
  afterEach(async function () {
    await fs.remove(dir);
    await fs.remove(blog);
  });
  function load(name) {
    const module = {exports:{}};
    const stubs = {
      clients:{},
      "sync/establishSyncLock":async()=>({folder:{update:updated},done}),
      "./index":{},
      "clients/util/shouldIgnoreFile":()=>false,
    };
    vm.runInNewContext(require("fs").readFileSync(require.resolve("../site/folder/"+name),"utf8"), {
      module, exports:module.exports, Buffer, console,
      require:name=>name in stubs ? stubs[name] : require(name),
    });
    return module.exports;
  }
  function response() {
    return {statusCode:200, status(code){this.statusCode=code;return this;}, json(body){this.body=body;return this;}};
  }
  it("does not overwrite through a symbolic-link ancestor", async function () {
    const uploaded = path.join(dir,"upload.txt");
    await fs.writeFile(uploaded,"replacement");
    const res = response();
    await load("upload")({
      blog:{id:blogID}, query:{}, body:{overwrite:true},
      files:{upload:[{path:uploaded,originalFilename:"ancestor/file.txt"}]},
    },res);
    expect(await fs.readFile(path.join(target,"file.txt"),"utf8")).toBe("original");
    expect(updated).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalled();
    expect(JSON.stringify(res.body)).toContain("Symbolic links");
  });
  it("does not delete through a symbolic-link ancestor", async function () {
    const res = response();
    await load("remove")({blog:{id:blogID},params:{path:"ancestor/file.txt"},body:{}},res);
    expect(res.statusCode).toBe(403);
    expect(await fs.readFile(path.join(target,"file.txt"),"utf8")).toBe("original");
    expect(updated).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalled();
    expect(res.body.error).toBe("Permission denied");
  });
  it("lists a folder without following symbolic links", async function () {
    await fs.writeFile(path.join(blog, "real.txt"), "real");

    const getContents = require("dashboard/site/folder/folder");
    const { contents } = await getContents({ id: blogID, timeZone: "UTC" }, "/", {});

    expect(contents.map((stat) => stat.name)).toEqual(["real.txt"]);
  });
});
