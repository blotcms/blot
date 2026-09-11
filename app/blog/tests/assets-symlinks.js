const fs = require("fs").promises;
const path = require("path");
const os = require("os");
const vm = require("vm");
const express = require("express");

describe("blog asset symlink policy", function () {
  let dir, server, url;
  beforeEach(async function () {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "blot-assets-links-"));
    const blog = path.join(dir, "blogs", "test");
    await fs.mkdir(path.join(blog, "folder"), {recursive:true});
    await fs.writeFile(path.join(blog, "folder/file.txt"), "ordinary");
    await fs.symlink("folder/file.txt", path.join(blog, "link.txt"));
    await fs.symlink("folder", path.join(blog, "ancestor"));
    await fs.mkdir(path.join(blog, "index-link"));
    await fs.symlink("../folder/file.txt", path.join(blog, "index-link/index.html"));
    const module = {exports:{}};
    const config = {blog_folder_dir:path.join(dir,"blogs"), blog_static_files_dir:path.join(dir,"static"), blot_directory:dir};
    vm.runInNewContext(await fs.readFile(require.resolve("../assets"), "utf8"), {
      module, exports:module.exports,
      require:name => name === "config" ? config : require(name),
    });
    const cdnModule = {exports:{}};
    vm.runInNewContext(await fs.readFile(require.resolve("../../cdn"), "utf8"), {
      module:cdnModule, exports:cdnModule.exports,
      require:name => name === "config" ? {...config, data_directory:dir, views_directory:dir} :
        name === "models/client" || name === "models/template/key" ? {} : require(name),
    });
    const app = express();
    app.use("/cdn", cdnModule.exports);
    app.use((req, res, next) => {req.blog = {id:"test"}; next();});
    app.use(module.exports);
    app.use((req,res) => res.sendStatus(404));
    server = await new Promise(resolve => { const s = app.listen(0,"127.0.0.1",() => resolve(s)); });
    url = "http://127.0.0.1:" + server.address().port;
  });
  afterEach(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, {recursive:true,force:true});
  });
  it("serves ordinary files including case-insensitive lookup", async function () {
    expect(await (await fetch(url + "/folder/file.txt")).text()).toEqual("ordinary");
    expect(await (await fetch(url + "/FOLDER/FILE.txt")).text()).toEqual("ordinary");
  });
  it("enforces the same policy on raw CDN files and implicit index files", async function () {
    expect(await (await fetch(url + "/cdn/folder/v-1/test/folder/file.txt")).text()).toEqual("ordinary");
    for (const suffix of ["link.txt", "ancestor/file.txt", "index-link/", "index-link/index.html"]) {
      const response = await fetch(url + "/cdn/folder/v-1/test/" + suffix);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not Found");
    }
  });
  it("refuses direct and ancestor symlinks through every path fallback", async function () {
    for (const suffix of ["/link.txt", "/ancestor/file.txt", "/ANCESTOR/FILE.txt"]) {
      expect((await fetch(url + suffix)).status).toBe(404);
    }
  });
});
