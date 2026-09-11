const assert = require("assert");
// Exercise the real downloader with controlled streams and no Drive account.
const fs = require("fs");
const vm = require("vm");
const { Readable, Writable, PassThrough } = require("stream");
function load(stubs) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve("../util/download"), "utf8"), {
    module, exports: module.exports, Buffer, console,
    require: name => Object.prototype.hasOwnProperty.call(stubs, name) ? stubs[name] : require(name),
  });
  return module.exports;
}
describe("Drive download completion", function () {
  let moved, removed, source, writer, finishWrite, download;
  beforeEach(function () {
    finishWrite = undefined;
    moved = false;
    removed = false;
    source = Readable.from([Buffer.from("new contents")]);
    writer = new Writable({ write(chunk, encoding, callback) { finishWrite = callback; } });
    download = load({
      "fs-extra": {
        createWriteStream: () => writer,
        move: async () => { moved = true; },
        remove: async () => { removed = true; },
        utimes: async () => {},
      },
      "helper/localPath": () => "/test-blog/file.txt",
      "colors/safe": { green: x => x },
      debug: () => () => {},
      "helper/tempDir": () => "/test-temp",
      "helper/guid": () => "download",
      "../util/md5Checksum": async () => "old",
      config: {}, "helper/hash": () => {}, cheerio: {}, yauzl: {},
      "../serviceAccount/hotDocPoller": {}, "../database": {},
    });
  });
  function start() {
    return download("blog", { files: { get: async () => ({ data: source }) } }, "/file.txt", {
      id: "file", mimeType: "text/plain", md5Checksum: "new", modifiedTime: "2026-01-01T00:00:00Z",
    });
  }
  async function writing() {
    while (!finishWrite) await new Promise(resolve => setImmediate(resolve));
  }
  it("publishes only after the destination finishes", async function () {
    let resolved = false;
    const pending = start().then(result => { resolved = true; return result; });
    await writing();
    expect(moved).toBe(false);
    expect(resolved).toBe(false);
    finishWrite();
    expect(await pending).toEqual({ updated: true });
    expect(moved).toBe(true);
  });
  it("rejects a late writer failure and cleans up without publishing", async function () {
    const pending = start();
    const rejection = assert.rejects(pending, /disk full/);
    await writing();
    finishWrite(new Error("disk full"));
    await rejection;
    expect(moved).toBe(false);
    expect(removed).toBe(true);
    expect(source.destroyed).toBe(true);
  });
  it("rejects a source failure and cleans up", async function () {
    source = new PassThrough();
    source.write("partial");
    const pending = start();
    const rejection = assert.rejects(pending, /connection lost/);
    await writing();
    source.destroy(new Error("connection lost"));
    await rejection;
    expect(moved).toBe(false);
    expect(removed).toBe(true);
    expect(writer.destroyed).toBe(true);
  });
});

describe("Drive download checksum optimization", function () {
  it("does not request content when the local checksum matches", async function () {
    let requested = false;
    const download = load({
      "fs-extra": {}, "helper/localPath": () => "/test-blog/file.txt",
      "colors/safe": {green:x=>x}, debug:()=>()=>{},
      "helper/tempDir":()=>"/test-temp", "helper/guid":()=>"download",
      "../util/md5Checksum":async()=>"same", config:{}, "helper/hash":()=>{},
      cheerio:{}, yauzl:{}, "../serviceAccount/hotDocPoller":{}, "../database":{},
    });
    const result = await download("blog", {files:{get:async()=>{requested=true;}}}, "/file.txt", {
      id:"file", mimeType:"text/plain", md5Checksum:"same",
    });
    expect(result).toEqual({updated:false});
    expect(requested).toBe(false);
  });
});
