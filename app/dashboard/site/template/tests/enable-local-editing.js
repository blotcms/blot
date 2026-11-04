describe("enable local editing", function () {
  global.test.blog();

  const Template = require("models/template");
  const enableLocalEditing = require("../save/enable-local-editing");

  function createTemplate(blogID) {
    return new Promise((resolve, reject) =>
      Template.create(blogID, "Local " + Date.now(), {}, (err, t) =>
        err ? reject(err) : resolve(t)
      )
    );
  }

  function getMetadata(id) {
    return new Promise((resolve, reject) =>
      Template.getMetadata(id, (e, m) => (e ? reject(e) : resolve(m)))
    );
  }

  it("turns local editing off and passes on the error if the folder write fails", async function () {
    const template = await createTemplate(this.blog.id);
    const failure = new Error("invalid_access_token");

    spyOn(Template, "writeToFolder").and.callFake(function (_b, _t, cb) {
      cb(failure);
    });

    const req = { blog: this.blog, template };
    const res = { message: jasmine.createSpy("message") };
    const err = await new Promise((resolve) =>
      enableLocalEditing(req, res, resolve)
    );

    expect(err).toBe(failure);
    expect(res.message).not.toHaveBeenCalled();
    expect((await getMetadata(template.id)).localEditing).toBe(false);
  });

  it("responds once the files are written", async function () {
    const template = await createTemplate(this.blog.id);

    spyOn(Template, "writeToFolder").and.callFake(function (_b, _t, cb) {
      cb();
    });

    const req = { blog: this.blog, template };
    const res = { message: jasmine.createSpy("message") };
    await new Promise((resolve) => {
      res.message.and.callFake(resolve);
      enableLocalEditing(req, res, resolve);
    });

    expect(res.message).toHaveBeenCalled();
    expect((await getMetadata(template.id)).localEditing).toBe(true);
  });
});
