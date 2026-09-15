describe("user", function () {
  var User = require("models/user");

  it("creates and deletes a user", function (done) {
    var email = "XXX@gmail.com";
    var passwordHash = "123";
    var subscription = {};
    var paypal = {};

    User.create(
      email,
      passwordHash,
      subscription,
      paypal,
      function (err, user) {
        expect(err).toBe(null);
        expect(user).toEqual(jasmine.any(Object));
        expect(user.created).toEqual(jasmine.any(Number));
        expect(user.created).toBeGreaterThan(0);
        expect(user.welcomeEmailSent).toBe(false);
        expect(user.paymentMethods).toEqual([]);

        User.remove(user.uid, function (err) {
          expect(err).toBe(null);
          done();
        });
      }
    );
  });

  it("retries creation when SETNX reports collision with false", function (done) {
    var create = require("models/user/create");
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
        }
      };
    });

    create(
      "retry-false@gmail.com",
      "hash",
      {},
      {},
      function (err, user) {
        expect(err).toBe(null);
        expect(user).toEqual(jasmine.any(Object));
        expect(execCalls).toBe(2);
        done();
      }
    );
  });
});
