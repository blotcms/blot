describe("regenerateTemplateManifests", function () {
  var client = require("models/client");
  var key = require("models/template/key");
  var Template = require("models/template");
  var regenerateTemplateManifests = require("../update/regenerateTemplateManifests");

  global.test.blog();

  var run = (blogID, log) => regenerateTemplateManifests(blogID, { log });

  beforeEach(async function () {
    await Template.create(this.blog.id, "template", {});

    var templates = await Template.getTemplateList(this.blog.id);

    this.templateID = templates.filter(
      (t) => t.name === "template" && t.owner === this.blog.id
    )[0].id;

    // No such template: updateCdnManifest fails with "No template: ..."
    this.missingID = this.blog.id + ":missing";
    this.pendingKey = key.templateManifestsPending(this.blog.id);
  });

  afterEach(async function () {
    await client.del(this.pendingKey);
  });

  it("puts a template whose regeneration failed back in the pending set", async function () {
    var log = jasmine.createSpy("log");

    await client.sAdd(this.pendingKey, [this.templateID, this.missingID]);

    var count = await run(this.blog.id, log);

    expect(count).toBe(1);
    expect(log).toHaveBeenCalled();
    expect(log.calls.argsFor(0)).toContain(this.missingID);

    // the failed one is retried by the next sync; the successful one is not
    expect((await client.sMembers(this.pendingKey)).sort()).toEqual([
      this.missingID,
    ]);
  });

  it("leaves the pending set empty when every regeneration succeeds", async function () {
    var log = jasmine.createSpy("log");

    await client.sAdd(this.pendingKey, [this.templateID]);

    expect(await run(this.blog.id, log)).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(await client.sMembers(this.pendingKey)).toEqual([]);
  });

  it("does not loop forever on a template that keeps failing", async function () {
    await client.sAdd(this.pendingKey, [this.missingID]);

    // the pending set is read once, so one run handles it exactly once
    expect(await run(this.blog.id, function () {})).toBe(0);
    expect(await client.sMembers(this.pendingKey)).toEqual([this.missingID]);
  });

  it("keeps a template pending until its manifest is regenerated", async function () {
    var pendingKey = this.pendingKey;
    var templateID = this.templateID;

    await client.sAdd(pendingKey, [templateID]);

    // Popping it first would lose it to a process killed mid-regeneration
    spyOn(client, "sPop").and.callThrough();
    spyOn(client, "sRem").and.callThrough();

    expect(await run(this.blog.id, function () {})).toBe(1);
    expect(client.sPop).not.toHaveBeenCalled();
    expect(client.sRem).toHaveBeenCalledWith(pendingKey, templateID);
    expect(await client.sMembers(pendingKey)).toEqual([]);
  });

  it("leaves a template pending if clearing it fails", async function () {
    await client.sAdd(this.pendingKey, [this.templateID]);

    spyOn(client, "sRem").and.callFake(() =>
      Promise.reject(new Error("killed"))
    );

    var log = jasmine.createSpy("log");

    expect(await run(this.blog.id, log)).toBe(1);
    expect(log).toHaveBeenCalled();
    client.sRem.and.callThrough();
    expect(await client.sMembers(this.pendingKey)).toEqual([this.templateID]);
  });
});
