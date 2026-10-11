describe("onedrive graph", function () {
  const nock = require("nock");
  const fs = require("fs-extra");
  const os = require("os");
  const { join } = require("path");
  const graph = require("../util/graph");
  const { connect, item } = require("./helpers");

  const GRAPH = "https://graph.microsoft.com";

  // Create test blog
  global.test.blog();

  beforeEach(async function () {
    await connect(this.blog.id);
  });

  afterEach(function () {
    nock.cleanAll();
  });

  it("follows paging links when listing a folder", async function () {
    nock(GRAPH)
      .get((uri) => uri.startsWith("/v1.0/me/drive/items/FOLDER/children"))
      .reply(200, {
        value: [item("a.txt", { sha1: "AA" })],
        "@odata.nextLink": GRAPH + "/v1.0/next-page",
      })
      .get("/v1.0/next-page")
      .reply(200, { value: [item("sub", { folder: true })] });

    const items = await graph.listChildren(this.blog.id, "FOLDER", "/");

    expect(items.map((i) => i.name)).toEqual(["a.txt", "sub"]);
    expect(items[0].sha1).toBe("AA");
    expect(items[1].is_directory).toBe(true);
  });

  it("lists subfolders by path relative to the blog folder", async function () {
    let requested;

    nock(GRAPH)
      .get(function (uri) {
        requested = uri;
        return uri.startsWith("/v1.0/me/drive/items/FOLDER:/my%20dir:/children");
      })
      .reply(200, { value: [] });

    await graph.listChildren(this.blog.id, "FOLDER", "/my dir");

    expect(requested).toContain("FOLDER:/my%20dir:/children");
  });

  it("retries throttled requests after Retry-After", async function () {
    nock(GRAPH)
      .get((uri) => uri.startsWith("/v1.0/me/drive/items/FOLDER"))
      .reply(429, { error: { code: "activityLimitReached" } }, { "Retry-After": "0" })
      .get((uri) => uri.startsWith("/v1.0/me/drive/items/FOLDER"))
      .reply(200, { id: "FOLDER", name: "Site" });

    const result = await graph.getItem(this.blog.id, "FOLDER");

    expect(result.name).toBe("Site");
  });

  it("throws errors with the HTTP status and Graph error code", async function () {
    nock(GRAPH)
      .get((uri) => uri.startsWith("/v1.0/me/drive/items/FOLDER"))
      .reply(404, { error: { code: "itemNotFound", message: "gone" } });

    let error;

    try {
      await graph.getItem(this.blog.id, "FOLDER");
    } catch (e) {
      error = e;
    }

    expect(error.status).toBe(404);
    expect(error.code).toBe("itemNotFound");
  });

  it("creates a folder that renames on conflict", async function () {
    let body;

    nock(GRAPH)
      .post("/v1.0/me/drive/items/ROOT/children", function (b) {
        body = b;
        return true;
      })
      .reply(201, { id: "NEW", name: "My Blog 1" });

    const created = await graph.createFolder(this.blog.id, "ROOT", "My Blog");

    expect(created.id).toBe("NEW");
    expect(body.name).toBe("My Blog");
    expect(body["@microsoft.graph.conflictBehavior"]).toBe("rename");
  });

  it("uploads a small file with a single PUT", async function () {
    const source = join(os.tmpdir(), "onedrive-graph-test-" + Date.now() + ".txt");

    await fs.outputFile(source, "hello");

    const put = nock(GRAPH)
      .put((uri) => uri.startsWith("/v1.0/me/drive/items/FOLDER:/dir/hello.txt:/content"))
      .reply(201, {});

    await graph.upload(this.blog.id, "FOLDER", "/dir/hello.txt", source);
    await fs.remove(source);

    expect(put.isDone()).toBe(true);
  });

  it("downloads an item, setting its modified time", async function () {
    const destination = join(os.tmpdir(), "onedrive-graph-download-" + Date.now(), "a.txt");

    nock(GRAPH).get("/v1.0/me/drive/items/id-a.txt/content").reply(200, "contents");

    await graph.download(
      this.blog.id,
      { id: "id-a.txt", modified: "2026-01-01T00:00:00Z" },
      destination
    );

    expect(await fs.readFile(destination, "utf8")).toBe("contents");
    expect((await fs.stat(destination)).mtime.toISOString()).toBe("2026-01-01T00:00:00.000Z");

    await fs.remove(join(destination, ".."));
  });
});
