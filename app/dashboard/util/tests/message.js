const express = require("express");
const fetch = require("node-fetch");
const { errorHandler } = require("../message");

describe("dashboard error message handler", function () {
  let server;
  let message;

  afterEach(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  async function post(error) {
    const app = express();

    app.use(express.urlencoded({ extended: false }));
    app.use(function (req, res, next) {
      res.message = jasmine.createSpy("message").and.callFake(function (url, err) {
        message = { url, error: err };
        res.status(302).end();
      });
      next(error);
    });
    app.use(errorHandler);

    server = await new Promise(resolve => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });

    await fetch(`http://127.0.0.1:${server.address().port}/save`, {
      method: "POST",
      body: "redirect=%2Faccount",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    return message;
  }

  it("prefers a message over enumerable metadata on object-shaped errors", async function () {
    const result = await post({
      message: "Choose a different account name",
      code: "ECONFLICT",
    });

    expect(result.url).toBe("/account");
    expect(result.error.message).toBe("Choose a different account name");
  });

  it("supports string fields on legacy object-shaped errors", async function () {
    const result = await post({ reason: "That account already exists" });

    expect(result.error.message).toBe("That account already exists");
  });

  it("falls back to Error when no message source is usable", async function () {
    const result = await post({ status: 409 });

    expect(result.error.message).toBe("Error");
  });
});
