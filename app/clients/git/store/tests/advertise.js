// The upload-pack ref advertisement, built from a manifest, and whether git
// accepts it.
const fx = require("./helpers/fixture");
const timeout = require("./helpers/timeout");
const { startServer, runGit, manifestOf } = require("./helpers/upload-server");
const createMemoryStore = require("../objectStore/memory");
const { advertise, CAPABILITIES } = require("../advertise");
const { split } = require("../pktline");

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

// [{ line, capabilities }] for each ref line of an advertisement
function lines(body) {
  const packets = split(body).filter((p) => p.data);
  expect(packets[0].data.toString()).toBe("# service=git-upload-pack");
  return packets.slice(1).map((p) => {
    const [line, capabilities] = p.data.toString("latin1").split("\0");
    return { line, capabilities: capabilities ? capabilities.split(" ") : null };
  });
}

describe("git store ref advertisement", function () {
  timeout(30 * 1000);

  it("starts with the service line and a flush, and ends with a flush", function () {
    const body = advertise(manifestOf([], A));
    expect(body.subarray(0, 4 + 26 + 4).toString()).toBe("001e# service=git-upload-pack\n0000");
    expect(body.subarray(body.length - 4).toString()).toBe("0000");
  });

  it("lists HEAD first, then the refs sorted by name, with the capabilities on the first line only", function () {
    const manifest = manifestOf([], A, { b: B, a: C });
    manifest.refs["refs/heads/dev"] = B;

    const found = lines(advertise(manifest));
    expect(found.map((f) => f.line)).toEqual([
      A + " HEAD",
      B + " refs/heads/dev",
      A + " refs/heads/master",
      C + " refs/tags/a",
      B + " refs/tags/b",
    ]);
    expect(found[0].capabilities).not.toBe(null);
    expect(found.slice(1).every((f) => f.capabilities === null)).toBe(true);
  });

  it("says where HEAD points", function () {
    const [first] = lines(advertise(manifestOf([], A)));
    expect(first.capabilities).toContain("symref=HEAD:refs/heads/master");
  });

  it("leaves HEAD out when its branch does not exist", function () {
    const manifest = manifestOf([], A);
    manifest.head = "refs/heads/trunk";

    const found = lines(advertise(manifest));
    expect(found.map((f) => f.line)).toEqual([A + " refs/heads/master"]);
    expect(found[0].capabilities.join(" ")).not.toMatch(/symref/);
  });

  it("advertises an empty repository as git does", function () {
    const found = lines(advertise(manifestOf([], null)));
    expect(found.length).toBe(1);
    expect(found[0].line).toBe("0".repeat(40) + " capabilities^{}");
    expect(found[0].capabilities).toEqual(jasmine.arrayContaining(CAPABILITIES));
  });

  it("offers only what the clone implements", function () {
    const [first] = lines(advertise(manifestOf([], A)));
    const names = first.capabilities.map((c) => c.split("=")[0]);

    expect(names).toEqual(jasmine.arrayContaining(["side-band-64k", "ofs-delta", "agent"]));
    for (const not of ["shallow", "deepen-since", "deepen-not", "deepen-relative", "filter", "multi_ack", "multi_ack_detailed", "no-done", "thin-pack", "include-tag", "allow-tip-sha1-in-want", "allow-reachable-sha1-in-want", "side-band"]) {
      expect(names).not.toContain(not);
    }
    expect(first.capabilities).toContain("object-format=sha1");
  });

  it("names the agent the host chooses", function () {
    const [first] = lines(advertise(manifestOf([], A), { agent: "blot-test" }));
    expect(first.capabilities).toContain("agent=blot-test");
  });

  it("asks the object store for nothing", async function () {
    const store = createMemoryStore();
    advertise(manifestOf([], A));
    expect(Object.values(store.stats).every((n) => n === 0)).toBe(true);
  });

  it("is read by git, which lists the refs", async function () {
    const dir = fx.tempDir();
    try {
      const fixture = fx.buildFixture(dir + "/repo", { commits: 3, large: false });
      const server = await startServer({ store: createMemoryStore(), manifest: () => manifestOf([], fixture.head, { v1: fixture.tag }) });
      try {
        const listed = await runGit(["ls-remote", server.url]);
        expect(listed.code).toBe(0);
        expect(listed.stdout.trim().split("\n")).toEqual([
          fixture.head + "\tHEAD",
          fixture.head + "\trefs/heads/master",
          fixture.tag + "\trefs/tags/v1",
        ]);
      } finally {
        await server.close();
      }
    } finally {
      fx.remove(dir);
    }
  });
});
