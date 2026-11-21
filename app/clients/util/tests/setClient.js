const fs = require("fs");
const vm = require("vm");

describe("setClient", function () {
  // Loads setClient with the clients and Blog.set stubbed, recording calls
  function load(clientNames, { failing } = {}) {
    const calls = [];
    const clients = {};
    for (const name of clientNames)
      clients[name] = {
        disconnect: async (blogID) => {
          calls.push(["disconnect", name, blogID]);
          if (name === failing) throw new Error("Disconnect failed");
        },
      };
    const stubs = {
      clients,
      "models/blog": {
        set: async (blogID, data) => calls.push(["set", blogID, data]),
      },
    };
    const module = { exports: {} };
    vm.runInNewContext(
      fs.readFileSync(require.resolve("../setClient"), "utf8"),
      { module, exports: module.exports, require: (name) => stubs[name] }
    );
    return { setClient: module.exports, calls };
  }

  it("disconnects the client the blog had before setting the new one", async function () {
    const { setClient, calls } = load(["google-drive", "dropbox"]);
    const blog = { id: "blog_a", client: "google-drive" };

    await setClient(blog, "dropbox");

    expect(calls).toEqual([
      ["disconnect", "google-drive", "blog_a"],
      ["set", "blog_a", { client: "dropbox" }],
    ]);
    expect(blog.client).toBe("dropbox");
  });

  it("disconnects nothing for a blog with no client, or the same one", async function () {
    const { setClient, calls } = load(["google-drive"]);

    await setClient({ id: "blog_a", client: "" }, "google-drive");
    await setClient({ id: "blog_b", client: "google-drive" }, "google-drive");

    expect(calls).toEqual([
      ["set", "blog_a", { client: "google-drive" }],
      ["set", "blog_b", { client: "google-drive" }],
    ]);
  });

  it("leaves the client as it was when the disconnect fails", async function () {
    const { setClient, calls } = load(["git"], { failing: "git" });
    const blog = { id: "blog_a", client: "git" };

    let error;
    try {
      await setClient(blog, "dropbox");
    } catch (err) {
      error = err;
    }

    expect(error && error.message).toBe("Disconnect failed");
    expect(calls).toEqual([["disconnect", "git", "blog_a"]]);
    expect(blog.client).toBe("git");
  });
});
