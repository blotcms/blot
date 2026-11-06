describe("prettyPrice", function () {
  const prettyPrice = require("helper/prettyPrice");
  const is = require("./util/is")(prettyPrice);

  it("works", function () {
    is(2134, "$21.34");
    is(2000, "$20");
    is(200, "$2");
    is(210, "$2.10");
    is(3, "$0.03");
    is(30, "$0.30");
  });
});
