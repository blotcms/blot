const asset = require("../asset");

describe("asset", function () {
  function getLambda() {
    return new Promise((resolve, reject) => {
      asset({}, {}, (err, factory) => {
        if (err) return reject(err);
        resolve(factory());
      });
    });
  }

  it("adds a leading slash and a cache-busting query string for files with an extension", async function () {
    const lambda = await getLambda();
    const render = (text) => text.replace("{{cacheID}}", "123");

    expect(lambda("logo.png", render)).toEqual(
      "/logo.png?cache=123&amp;extension=.png"
    );
  });

  it("leaves an existing leading slash alone", async function () {
    const lambda = await getLambda();
    const render = (text) => text.replace("{{cacheID}}", "123");

    expect(lambda("/logo.png", render)).toEqual(
      "/logo.png?cache=123&amp;extension=.png"
    );
  });

  it("does not append a cache-busting query string for text without an extension", async function () {
    const lambda = await getLambda();
    const render = (text) => text;

    expect(lambda("logo", render)).toEqual("/logo");
  });
});
