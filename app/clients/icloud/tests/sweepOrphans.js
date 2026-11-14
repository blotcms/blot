describe("icloud sweepOrphans", function () {
  const sweepOrphans = require("../sweepOrphans");

  // blogs: id -> blog (absent = deleted); accounts: ids with an account record
  function setup({ folders, blogs = {}, accounts = [] }) {
    const removed = [];
    const deletedAccounts = [];
    const deps = {
      list: async () => folders,
      remove: async (id) => removed.push(id),
      getBlog: async (id) => blogs[id],
      getAccount: async (id) => (accounts.includes(id) ? { id } : null),
      deleteAccount: async (id) => deletedAccounts.push(id),
      log: () => {},
    };
    return { deps, removed, deletedAccounts };
  }

  const connected = (n) => Array.from({ length: n }, (_, i) => "blog_live" + i);
  const icloudBlogs = (ids) =>
    Object.fromEntries(ids.map((id) => [id, { client: "icloud" }]));

  it("finds folders of deleted blogs and of blogs on another client", async function () {
    const live = connected(20);
    const { deps, removed } = setup({
      folders: [...live, "blog_deleted", "blog_dropbox"],
      blogs: { ...icloudBlogs(live), blog_dropbox: { client: "dropbox" } },
      accounts: live,
    });

    const result = await sweepOrphans({ deps });

    expect(result.orphans).toEqual([
      { blogID: "blog_deleted", reason: "blog deleted" },
      { blogID: "blog_dropbox", reason: "client is dropbox" },
    ]);
    expect(removed).toEqual([]);
  });

  it("removes them with apply, and a deleted blog's account record", async function () {
    const live = connected(20);
    const { deps, removed, deletedAccounts } = setup({
      folders: [...live, "blog_deleted", "blog_none"],
      blogs: { ...icloudBlogs(live), blog_none: { client: "" } },
      accounts: [...live, "blog_deleted"],
    });

    const result = await sweepOrphans({ apply: true, deps });

    expect(removed).toEqual(["blog_deleted", "blog_none"]);
    expect(deletedAccounts).toEqual(["blog_deleted"]);
    expect(result.removed).toEqual(["blog_deleted", "blog_none"]);
  });

  it("keeps a blog mid-setup or with an account under another client", async function () {
    const live = connected(20);
    const { deps, removed } = setup({
      folders: [...live, "blog_settingup", "blog_switching"],
      blogs: {
        ...icloudBlogs(live),
        blog_settingup: { client: "icloud" },
        blog_switching: { client: "" },
      },
      accounts: [...live, "blog_switching"],
    });

    const result = await sweepOrphans({ apply: true, deps });

    expect(result.orphans).toEqual([]);
    expect(removed).toEqual([]);
  });

  it("keeps a blog that reconnected between the passes", async function () {
    const live = connected(20);
    const blogs = icloudBlogs(live);
    const { deps, removed } = setup({ folders: [...live, "blog_back"], blogs });
    let lookups = 0;
    deps.getBlog = async (id) => {
      if (id !== "blog_back") return blogs[id];
      return ++lookups === 1 ? undefined : { client: "icloud" };
    };

    await sweepOrphans({ apply: true, deps });

    expect(removed).toEqual([]);
  });

  it("removes none when too many folders look orphaned", async function () {
    const { deps, removed } = setup({
      folders: [...connected(5), "blog_a", "blog_b"],
      blogs: icloudBlogs(connected(5)),
    });

    const result = await sweepOrphans({ apply: true, deps });

    expect(result.orphans.length).toBe(2);
    expect(result.refused).toContain("over the limit");
    expect(removed).toEqual([]);
  });

  it("stops before removing anything when a lookup fails", async function () {
    const live = connected(20);
    const { deps, removed } = setup({
      folders: [...live, "blog_deleted"],
      blogs: icloudBlogs(live),
    });
    deps.getBlog = async (id) => {
      if (id === "blog_live3") throw new Error("Redis down");
      return icloudBlogs(live)[id];
    };

    let error;
    try {
      await sweepOrphans({ apply: true, deps });
    } catch (err) {
      error = err;
    }

    expect(error && error.message).toBe("Redis down");
    expect(removed).toEqual([]);
  });

  it("carries on past a folder the macserver fails to remove", async function () {
    const live = connected(20);
    const { deps, removed } = setup({
      folders: [...live, "blog_x", "blog_y"],
      blogs: icloudBlogs(live),
    });
    deps.remove = async (id) => {
      if (id === "blog_x") throw new Error("HTTP error: 500");
      removed.push(id);
    };

    const result = await sweepOrphans({ apply: true, deps });

    expect(result.failed).toEqual(["blog_x"]);
    expect(result.removed).toEqual(["blog_y"]);
  });
});
