describe("templates skipUnchanged", function () {
  const client = require("models/client");
  const Template = require("models/template");
  const templates = require("templates");
  const KEY = "templates:build:fingerprint";

  beforeEach(async function () {
    this.original = await client.get(KEY);
    await client.del(KEY);
    this.pass = spyOn(Template, "getTemplateList").and.callThrough();
  });

  afterEach(async function () {
    if (this.original) await client.set(KEY, this.original);
    else await client.del(KEY);
  });

  it("builds once, then stops until an input changes", async function () {
    await templates({ skipUnchanged: true });
    const stored = await client.get(KEY);
    expect(stored).toEqual(jasmine.any(String));
    expect(this.pass).toHaveBeenCalled();

    this.pass.calls.reset();
    await templates({ skipUnchanged: true });
    expect(this.pass).not.toHaveBeenCalled();

    await client.set(KEY, "from another worktree");
    await templates({ skipUnchanged: true });
    expect(this.pass).toHaveBeenCalled();
    expect(await client.get(KEY)).toEqual(stored);
  });

  it("does not store a fingerprint when the build fails", async function () {
    this.pass.and.callFake(async function () {
      throw new Error("Build failure");
    });

    await expectAsync(templates({ skipUnchanged: true })).toBeRejected();

    expect(await client.get(KEY)).toBe(null);
  });

  it("returns a promise that rejects when the build fails", async function () {
    const result = require("templates")({ skipUnchanged: true });
    expect(typeof result.then).toBe("function");
    await result;

    this.pass.and.callFake(async function () {
      throw new Error("Build failure");
    });

    try {
      await require("templates")({});
      fail("expected the build to reject");
    } catch (err) {
      expect(err.message).toBe("Build failure");
    }
  });

  it("always builds without the option, and drops the fingerprint", async function () {
    await templates({ skipUnchanged: true });
    expect(await client.get(KEY)).toEqual(jasmine.any(String));

    this.pass.calls.reset();
    await templates({});
    expect(this.pass).toHaveBeenCalled();
    expect(await client.get(KEY)).toBe(null);
  });
});
