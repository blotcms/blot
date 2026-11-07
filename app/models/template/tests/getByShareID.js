describe("template", function () {
  require("./setup")({ createTemplate: true, createView: true });

  var createShareID = require("../index").createShareID;
  var getByShareID = require("../index").getByShareID;

  it("getByShareID works", async function () {
    var test = this;
    const shareID = await createShareID(test.template.id);
    expect(typeof shareID).toEqual("string");
    const template = await getByShareID(shareID);
    expect(template.id).toEqual(test.template.id);
    expect(template.shareID).toEqual(shareID);
  });
});
