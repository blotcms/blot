const isActive = require("../is_active");

describe("is_active", function () {
  function getLambda(url) {
    return new Promise((resolve, reject) => {
      isActive({ url: url }, {}, (err, factory) => {
        if (err) return reject(err);
        resolve(factory());
      });
    });
  }

  it("marks the current page as active", async function () {
    const lambda = await getLambda("/about");
    expect(lambda("/about")).toEqual("active");
  });

  it("leaves other pages unmarked", async function () {
    const lambda = await getLambda("/about");
    expect(lambda("/contact")).toEqual("");
  });

  it("normalizes trailing slashes and case before comparing", async function () {
    const lambda = await getLambda("/About/");
    expect(lambda("/about")).toEqual("active");
  });

  it("treats an empty request url as the homepage", async function () {
    const lambda = await getLambda("");
    expect(lambda("/")).toEqual("active");
  });
});
