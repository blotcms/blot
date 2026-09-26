describe("template deserialize", function () {
  var deserialize = require("../util/deserialize");
  var metadataModel = require("../metadataModel");
  var viewModel = require("../viewModel");

  it("drops leftover isPublic from a metadata hash", function () {
    var metadata = deserialize(
      {
        id: "SITE:blog",
        name: "Blog",
        owner: "SITE",
        isPublic: "true",
        localEditing: "false",
        locals: '{"color":"red"}',
      },
      metadataModel
    );

    expect(metadata.isPublic).toBeUndefined();
    expect(metadata.id).toBe("SITE:blog");
    expect(metadata.owner).toBe("SITE");
    expect(metadata.localEditing).toBe(false);
    expect(metadata.locals).toEqual({ color: "red" });
  });

  it("keeps a legacy view type for an extensionless stylesheet", function () {
    var view = deserialize(
      {
        name: "style",
        content: "body{}",
        type: "text/css",
      },
      viewModel
    );

    expect(view.name).toBe("style");
    expect(view.content).toBe("body{}");
    expect(view.type).toBe("text/css");
  });
});
