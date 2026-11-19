const folder = require("storage/folder");
const download = require("../util/download");

describe("dropbox download with metadata passed in", function () {
  const blogID = "blog_downloadmeta" + Date.now();

  afterEach(async function () {
    await folder.removeAll(blogID);
  });

  function fakeClient() {
    return {
      filesGetMetadata: jasmine
        .createSpy("filesGetMetadata")
        .and.returnValue(
          Promise.resolve({ result: { path_display: "/a.txt", size: 2 } })
        ),
      filesDownload: jasmine.createSpy("filesDownload").and.returnValue(
        Promise.resolve({
          result: { fileBinary: Buffer.from("hi") },
        })
      ),
    };
  }

  it("skips filesGetMetadata", async function () {
    const client = fakeClient();

    await download(client, "/a.txt", blogID, "/a.txt", {
      metadata: { path_display: "/a.txt", size: 2 },
    });

    expect(client.filesGetMetadata).not.toHaveBeenCalled();
    expect((await folder.read(blogID, "/a.txt")).toString()).toBe("hi");
  });

  it("still applies the unsupported extension check to the metadata", async function () {
    const client = fakeClient();

    await download(client, "/a.exe", blogID, "/a.exe", {
      metadata: { path_display: "/a.exe", size: 2 },
    });

    expect(client.filesGetMetadata).not.toHaveBeenCalled();
    expect(client.filesDownload).not.toHaveBeenCalled();
  });

  it("falls back to filesGetMetadata without it", async function () {
    const client = fakeClient();

    await download(client, "/a.txt", blogID, "/a.txt");

    expect(client.filesGetMetadata).toHaveBeenCalledTimes(1);
    expect((await folder.read(blogID, "/a.txt")).toString()).toBe("hi");
  });
});
