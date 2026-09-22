const health = require("clients/health");
const getHealth = require("../getHealth");

describe("Google Drive getHealth", function () {
  it("reports the API suspension as an unavailable error", async function () {
    const result = await getHealth("blog_1");

    expect(result.state).toBe(health.STATES.ERROR);
    expect(result.issues).toEqual([
      {
        code: health.CODES.UNAVAILABLE,
        message: getHealth.MESSAGE,
      },
    ]);
    expect(result.issues[0].message).toMatch(/API access was suspended/);
    expect(result.issues[0].message).toMatch(/submitted an appeal/);
    expect(result.issues[0].message).toMatch(/new method/);
    expect(result.issues[0].message).toMatch(
      /continue to edit your folder, but your site will not update/
    );
    expect(result.issues[0].message).toMatch(/new username/);
  });
});
