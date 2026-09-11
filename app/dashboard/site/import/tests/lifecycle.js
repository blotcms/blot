const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const lifecycle = require("../lifecycle");
const wordpress = require("../sources/wordpress");
const helper = require("../helper");
const assetDirectory = require("../helper/asset_directory");
const client = require("models/client");
const init = require("../init");

const xml = `<?xml version="1.0"?><rss><channel><title>Test</title><link>https://example.com</link>
<item><title>First post</title><link>https://example.com/post</link><pubDate>Tue, 04 Aug 2020 12:00:00 GMT</pubDate><wp:post_type>post</wp:post_type><wp:status>publish</wp:status><content:encoded><![CDATA[<p>Hello</p>]]></content:encoded></item>
<item><title>Second post</title><link>https://example.com/post</link><pubDate>Tue, 04 Aug 2020 12:00:00 GMT</pubDate><wp:post_type>post</wp:post_type><wp:status>publish</wp:status><content:encoded><![CDATA[<p>Later</p>]]></content:encoded></item>
</channel></rss>`;

describe("import job lifecycle", function () {
  let job;
  beforeEach(function () {
    spyOn(client, "publish").and.returnValue(Promise.resolve());
    job = init({ blogID: "test", label: "Test" });
  });
  afterEach(async function () { await fs.remove(job.importDirectory); });

  it("allocates distinct job identities in the same millisecond", async function () {
    const now = Date.now();
    spyOn(Date, "now").and.returnValue(now);
    const first = init({ blogID: "test", label: "Collision" });
    const second = init({ blogID: "test", label: "Collision" });
    try {
      expect(first.importID).not.toBe(second.importID);
      expect(parseInt(first.importID.split("-").pop(), 10)).toBe(now);
      await Promise.all([first.run(async () => {}), second.run(async () => {})]);
    } finally {
      await fs.remove(first.importDirectory);
      await fs.remove(second.importDirectory);
      await job.run(async () => {});
    }
  });

  it("recovers an expired worker while retaining a revocation tombstone", async function () {
    await fs.outputFile(path.join(job.outputDirectory, "partial.txt"), "partial");
    await fs.outputFile(path.join(job.importDirectory, "staging", "asset"), "partial");
    const leaseFile = path.join(job.importDirectory, "running.txt");
    const lease = await fs.readJson(leaseFile);
    lease.expiresAt = Date.now() - 1;
    await fs.writeJson(leaseFile, lease);
    const response = { locals: {} };
    await require("../list")({ blog: { id: "test" } }, response, () => {});
    expect(response.locals.imports.find(item => item.id === job.importID).complete).toBe(true);
    expect(await lifecycle.remove(job.importDirectory)).toBe(true);
    await require("../list")({ blog: { id: "test" } }, response, () => {});
    expect(response.locals.imports.find(item => item.id === job.importID)).toBeUndefined();
    expect(fs.existsSync(job.outputDirectory)).toBe(false);
    expect(fs.existsSync(path.join(job.importDirectory, "staging"))).toBe(false);
    expect(fs.existsSync(path.join(job.importDirectory, "deleted.txt"))).toBe(true);
    const resumed = jasmine.createSpy("resumed worker");
    await job.run(resumed);
    expect(resumed).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(job.importDirectory, "deleted.txt"))).toBe(true);
    expect(fs.existsSync(path.join(job.importDirectory, "result.zip"))).toBe(false);
  });

  it("cancels a fresh owner but waits for its cleanup before deleting", async function () {
    expect(await lifecycle.remove(job.importDirectory)).toBe(false);
    expect(fs.existsSync(path.join(job.importDirectory, "deleted.txt"))).toBe(false);
    await job.run(async () => {});
    expect(await lifecycle.remove(job.importDirectory)).toBe(true);
    expect(fs.existsSync(job.importDirectory)).toBe(false);
  });

  it("rejects a replaced ownership token even if its lease is fresh", async function () {
    const leaseFile = path.join(job.importDirectory, "running.txt");
    const lease = await fs.readJson(leaseFile);
    lease.owner = "another worker";
    await fs.writeJson(leaseFile, lease);
    const worker = jasmine.createSpy("worker");
    await job.run(worker);
    expect(worker).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(job.importDirectory, "error.txt"))).toBe(false);
    expect((await fs.readJson(leaseFile)).owner).toBe("another worker");
  });

  it("publishes Finished only after a readable archive exists", async function () {
    await job.run(() => fs.outputFile(path.join(job.outputDirectory, "post.txt"), "hello"));
    expect(fs.readFileSync(path.join(job.importDirectory, "result.zip")).slice(0, 2).toString()).toBe("PK");
    expect(fs.readFileSync(path.join(job.importDirectory, "status.txt"), "utf8")).toBe("Finished");
    expect(fs.existsSync(path.join(job.importDirectory, "result.zip.part"))).toBe(false);
  });

  it("removes partial output and asset staging directories on cancellation", async function () {
    let staging;
    await job.run(async () => {
      await fs.outputFile(path.join(job.outputDirectory, "partial.txt"), "partial");
      staging = await new Promise((resolve, reject) => assetDirectory({}, (err, dir) => err ? reject(err) : resolve(dir)));
      await fs.outputFile(path.join(staging, "asset"), "partial");
      await lifecycle.cancel(job.importDirectory);
    });
    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.existsSync(job.outputDirectory)).toBe(false);
    expect(fs.existsSync(path.join(job.importDirectory, "result.zip"))).toBe(false);
    expect(fs.readFileSync(path.join(job.importDirectory, "status.txt"), "utf8")).toBe("Cancelled");
  });

  it("cancels an archive in progress and removes its partial zip", async function () {
    const create = fs.createWriteStream;
    spyOn(fs, "createWriteStream").and.callFake(function (...args) {
      const stream = create(...args);
      const write = stream.write;
      let cancelled = false;
      stream.write = function (...writeArgs) {
        if (!cancelled) {
          cancelled = true;
          fs.writeFileSync(path.join(job.importDirectory, "cancelled.txt"), "true");
          lifecycle.current().abort();
        }
        return write.apply(this, writeArgs);
      };
      return stream;
    });
    await job.run(() => fs.outputFile(path.join(job.outputDirectory, "post.txt"), "hello"));
    expect(fs.existsSync(path.join(job.importDirectory, "result.zip.part"))).toBe(false);
    expect(fs.existsSync(path.join(job.importDirectory, "result.zip"))).toBe(false);
    expect(fs.readFileSync(path.join(job.importDirectory, "status.txt"), "utf8")).toBe("Cancelled");
  });

  it("reports WordPress write errors with the post title and stops before the next post", async function () {
    const input = path.join(job.importDirectory, "input.xml");
    await fs.outputFile(input, xml);
    const writer = jasmine.createSpy("writer").and.callFake((post, cb) => cb(new Error("ENOSPC")));
    spyOn(helper.write, "createWriter").and.returnValue(writer);
    await job.run(() => new Promise((resolve, reject) => wordpress(input, job.outputDirectory, job.status, {}, err => err ? reject(err) : resolve())));
    expect(writer.calls.count()).toBe(1);
    expect(fs.readFileSync(path.join(job.importDirectory, "error.txt"), "utf8")).toContain("First post: ENOSPC");
    expect(fs.readFileSync(path.join(job.importDirectory, "status.txt"), "utf8")).toBe("Failed");
    expect(fs.existsSync(path.join(job.importDirectory, "result.zip"))).toBe(false);
  });

  it("stops between WordPress entries without finalizing", async function () {
    const input = path.join(job.importDirectory, "input.xml");
    await fs.outputFile(input, xml);
    const writer = jasmine.createSpy("writer").and.callFake((post, cb) => {
      lifecycle.cancel(job.importDirectory).then(() => cb(), cb);
    });
    spyOn(helper.write, "createWriter").and.returnValue(writer);
    await job.run(() => new Promise((resolve, reject) => wordpress(input, job.outputDirectory, job.status, {}, err => err ? reject(err) : resolve())));
    expect(writer.calls.count()).toBe(1);
    expect(fs.readFileSync(path.join(job.importDirectory, "status.txt"), "utf8")).toBe("Cancelled");
    expect(fs.existsSync(path.join(job.importDirectory, "result.zip"))).toBe(false);
  });
});
