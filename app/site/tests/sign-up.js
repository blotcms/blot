describe("Blot sign up", function () {
  const { promisify } = require("util");
  const User = require("models/user");
  const browser = require("./util/browser");

  global.test.site();

  const email = "sign-up-spec@example.com";

  afterEach(async function () {
    const user = await promisify(User.getByEmail)(email);

    if (user) await promisify(User.remove)(user.uid);
  });

  it("works", async function () {
    const page = browser(this);

    // Entering a card needs Stripe's script and Stripe's API, neither of
    // which a test can use. Accounts that were paid for elsewhere sign up
    // through a link with an access token instead, which skips only the
    // payment form and goes through the same account and site creation.
    const token = await promisify(User.generateAccessToken)({ uid: "sign-up" });

    await page.goto("/sites/sign-up/paid/" + token);
    page.type("input[name=email]", email);
    await page.click("[type=submit]");

    expect(page.url).toEqual(this.origin + "/sites/sign-up/create-account");

    // enter a password
    page.type("input[name=password]", "password");
    await page.click("[type=submit]");

    // the create site page should load
    expect(page.url).toEqual(this.origin + "/sites/account/create-site");

    // enter a title for the site
    page.type("input[name=title]", "Test Site");
    await page.click("[type=submit]");

    // the client page of the new site should load
    expect(page.url).toEqual(this.origin + "/sites/testsite/settings/folder");
  });
});
