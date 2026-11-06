const indentation = require("../indentation");

describe("indentation", function () {
  function testIndentation(input, expected) {
    it("handles " + input, function () {
      expect(indentation(input)).toEqual(expected);
    });
  }

  function m() {
    var args = Array.prototype.slice.call(arguments);
    return args.join("\n");
  }

  var aIn = m("<foo>", "    <bar>", "</foo>");

  var aOut = m("<foo>", "<bar>", "</foo>");

  testIndentation(aIn, aOut);

  // testIndentation(bIn, bOut);

  var cIn = m("```", "<li>", "  Chet", "</li>", "```");

  testIndentation(cIn, cIn);
});
