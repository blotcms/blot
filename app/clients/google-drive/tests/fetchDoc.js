const fs = require("fs");
const vm = require("vm");
const { dirname, resolve } = require("path");

// util/fetchDoc.js with Google, the bucket, the folder and Redis stubbed
describe("google drive fetchDoc", function () {
  function harness() {
    const state = {
      gets: 0,
      fetched: [],
      written: [],
      removed: [],
      files: new Map(),
      records: new Map(),
      doc: null,
    };
    const file = require.resolve("../util/fetchDoc");
    const stubs = {
      "storage/folder": {
        write: async (blogID, path, data) => {
          state.folderWrites = (state.folderWrites || 0) + 1;
          state.files.set(path, data);
        },
        exists: async (blogID, path) => state.files.has(path),
        read: async (blogID, path) => {
          if (!state.files.has(path)) throw new Error("ENOENT");
          return Buffer.from(state.files.get(path));
        },
      },
      "storage/assets": {
        write: async (blogID, path) => state.written.push(path),
        remove: async (blogID, path) => state.removed.push(path),
      },
      "helper/clfdate": () => "",
      "../database": {
        blog: { get: async () => ({ serviceAccountId: "sa" }) },
      },
      "../database/docImages": {
        get: async (blogID, id) => state.records.get(id) || {},
        set: async (blogID, id, record) => state.records.set(id, record),
      },
      "../serviceAccount/createDocsClient": async () => ({}),
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, "utf8"), {
      module,
      exports: module.exports,
      console: { log() {}, error() {} },
      Buffer,
      AbortController,
      setTimeout,
      clearTimeout,
      fetch: async (uri) => {
        state.fetched.push(uri);
        return {
          ok: true,
          headers: { get: () => "image/png" },
          arrayBuffer: async () => Buffer.from("bytes of " + uri),
        };
      },
      require: (name) =>
        name in stubs
          ? stubs[name]
          : require(name.startsWith(".") ? resolve(dirname(file), name) : name),
    });
    const docs = {
      documents: {
        get: async () => {
          state.gets += 1;
          return { data: JSON.parse(JSON.stringify(state.doc)) };
        },
      },
    };
    state.fetch = (path = "/post.gdoc") =>
      module.exports(
        "blog_a",
        path,
        { id: "doc" },
        { serviceAccountId: "sa", docs }
      );
    return state;
  }

  const doc = (
    text,
    image = { uri: "https://google/image-1", width: 100 }
  ) => ({
    documentId: "doc",
    tabs: [
      {
        documentTab: {
          body: {
            content: [
              {
                paragraph: {
                  elements: [{ textRun: { content: text + "\n" } }],
                },
              },
              {
                paragraph: {
                  elements: [
                    { inlineObjectElement: { inlineObjectId: "kix.1" } },
                  ],
                },
              },
            ],
          },
          inlineObjects: {
            "kix.1": {
              inlineObjectProperties: {
                embeddedObject: {
                  imageProperties: { contentUri: image.uri },
                  size: { width: { magnitude: image.width } },
                },
              },
            },
          },
        },
      },
    ],
  });

  it("stores the Doc's JSON with each image's Blot path in place of its link", async function () {
    const h = harness();
    h.doc = doc("Hello");

    expect(await h.fetch()).toEqual({ updated: true });

    const stored = JSON.parse(h.files.get("/post.gdoc"));
    const image =
      stored.tabs[0].documentTab.inlineObjects["kix.1"].inlineObjectProperties
        .embeddedObject.imageProperties;
    expect(image.contentUri).toBeUndefined();
    expect(image.blotSrc).toMatch(/^\/_assets\/[a-f0-9]+\/[a-f0-9]{16}\.png$/);
    expect(h.written.length).toBe(1);
    // Nothing in the served file leads back to the Doc
    expect(stored.documentId).toBeUndefined();
    expect(stored.blotDoc).toBe(1);
  });

  it("makes no image request at all when only the text changed", async function () {
    const h = harness();
    h.doc = doc("Hello");
    await h.fetch();
    h.fetched = [];
    h.written = [];

    // The link changes on every docs.get, the image doesn't
    h.doc = doc("Hello, edited", {
      uri: "https://google/image-1?again",
      width: 100,
    });
    await h.fetch();

    expect(h.fetched).toEqual([]);
    expect(h.written).toEqual([]);
    expect(h.removed).toEqual([]);
    expect(h.files.get("/post.gdoc")).toContain("Hello, edited");
  });

  it("fetches a changed image and deletes the one it replaced", async function () {
    const h = harness();
    h.doc = doc("Hello");
    await h.fetch();
    const first = h.written[0];

    h.doc = doc("Hello", { uri: "https://google/image-2", width: 200 });
    await h.fetch();

    expect(h.fetched.length).toBe(2);
    expect(h.removed).toEqual([first]);
  });

  it("fetches the images again for a Doc renamed to another path", async function () {
    const h = harness();
    h.doc = doc("Hello");
    await h.fetch("/post.gdoc");
    await h.fetch("/renamed.gdoc");

    expect(h.fetched.length).toBe(2);
  });

  it("writes nothing when Blot already holds this revision", async function () {
    const h = harness();
    h.doc = { ...doc("Hello"), revisionId: "r1" };
    await h.fetch();
    expect(h.folderWrites).toBe(1);

    expect(await h.fetch()).toEqual({ updated: false });
    expect(h.folderWrites).toBe(1);
    expect(h.fetched.length).toBe(1);

    h.doc = { ...doc("Hello again"), revisionId: "r2" };
    expect(await h.fetch()).toEqual({ updated: true });
    expect(h.folderWrites).toBe(2);
  });

  it("leaves a Doc with a drawing to the zip export", async function () {
    const h = harness();
    h.doc = doc("Hello");
    delete h.doc.tabs[0].documentTab.inlineObjects["kix.1"]
      .inlineObjectProperties.embeddedObject.imageProperties;

    expect(await h.fetch()).toBeNull();
    expect(h.files.size).toBe(0);
  });
});
