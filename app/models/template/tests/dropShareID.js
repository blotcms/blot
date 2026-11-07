describe("template", function () {
  require("./setup")({ createTemplate: true, createView: true });

  var createShareID = require("../index").createShareID;
  var dropShareID = require("../index").dropShareID;
  var client = require("models/client");

  it("dropShareID works", async function () {
    var test = this;
    const shareID = await createShareID(test.template.id);
    expect(typeof shareID).toEqual("string");
    await dropShareID(shareID);
    const result = await client.keys("*" + shareID + "*");
    expect(result).toEqual([]);
  });
});
