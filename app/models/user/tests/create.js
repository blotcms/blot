describe("user", function () {
  var User = require("models/user");
  var promisify = require("util").promisify;
  var create = promisify(User.create);
  var remove = promisify(User.remove);

  it("creates and deletes a user", async function () {
    var email = "XXX@gmail.com";
    var passwordHash = "123";
    var subscription = {};
    var paypal = {};

    var user = await create(email, passwordHash, subscription, paypal);
    expect(user).toEqual(jasmine.any(Object));
    expect(user.created).toEqual(jasmine.any(Number));
    expect(user.created).toBeGreaterThan(0);
    expect(user.welcomeEmailSent).toBe(false);
    expect(user.paymentMethods).toEqual([]);

    await remove(user.uid);
  });

  it("retries creation when SETNX reports collision with false", async function () {
    var client = require("models/client");

    var execCalls = 0;

    spyOn(client, "multi").and.callFake(function () {
      var commands = [];

      return {
        sAdd: function () {
          commands.push("sAdd");
          return this;
        },
        setNX: function () {
          commands.push("setNX");
          return this;
        },
        set: function () {
          commands.push("set");
          return this;
        },
        exec: async function () {
          execCalls += 1;

          if (execCalls === 1) return [1, false, "OK", "OK"];
          return [1, true, "OK", "OK"];
        },
      };
    });

    var user = await create("retry-false@gmail.com", "hash", {}, {});
    expect(user).toEqual(jasmine.any(Object));
    expect(execCalls).toBe(2);
  });
});
