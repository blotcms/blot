const fs = require("fs");
const path = require("path");
const {
  MAX_EMAIL_LENGTH,
  MAX_PASSWORD_LENGTH,
  emailIsTooLong,
  passwordIsTooLong,
} = require("models/user/auth-limits");
const express = require("express");
const http = require("http");
const parseAuth = require("../parse-auth");

describe("authentication form limits", function () {
  it("accepts an email at the maximum length", function () {
    expect(emailIsTooLong("a".repeat(MAX_EMAIL_LENGTH))).toBe(false);
  });

  it("rejects an email over the maximum length", function () {
    expect(emailIsTooLong("a".repeat(MAX_EMAIL_LENGTH + 1))).toBe(true);
  });

  it("counts multi-byte email characters toward the octet limit", function () {
    expect(emailIsTooLong("é".repeat(MAX_EMAIL_LENGTH / 2 + 1))).toBe(true);
  });

  it("accepts a password at the maximum byte length", function () {
    expect(passwordIsTooLong("a".repeat(MAX_PASSWORD_LENGTH))).toBe(false);
  });

  it("rejects a password over the maximum byte length", function () {
    expect(passwordIsTooLong("a".repeat(MAX_PASSWORD_LENGTH + 1))).toBe(true);
  });

  it("counts multi-byte password characters toward the byte limit", function () {
    expect(passwordIsTooLong("é".repeat(MAX_PASSWORD_LENGTH / 2 + 1))).toBe(
      true
    );
  });

  it("rejects request bodies over the auth form limit", async function () {
    const app = express();
    app.post("/", parseAuth, function (req, res) {
      res.sendStatus(200);
    });
    app.use(function (err, req, res, next) {
      res.sendStatus(err.status || 500);
    });

    const server = await new Promise(function (resolve) {
      const server = app.listen(0, function () {
        resolve(server);
      });
    });

    try {
      const response = await new Promise(function (resolve, reject) {
        const body = "field=" + "a".repeat(4096);
        const request = http.request({
          method: "POST",
          port: server.address().port,
          path: "/",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(body),
          },
        }, resolve);
        request.on("error", reject);
        request.end(body);
      });

      expect(response.statusCode).toBe(413);
      response.resume();
    } finally {
      await new Promise(function (resolve) {
        server.close(resolve);
      });
    }
  });

  it("treats mixed-case authentication paths as auth forms", function () {
    expect(parseAuth.isAuthFormPath("/SIGN-UP")).toBe(true);
    expect(parseAuth.isAuthFormPath("/Log-In/reset")).toBe(true);
    expect(parseAuth.isAuthFormPath("/account/password/set")).toBe(true);
    expect(parseAuth.isAuthFormPath("/account/delete")).toBe(false);
  });

  it("does not parse multipart bodies on authentication form paths", async function () {
    const parseMultipart = require("../multipart")();
    const app = express();
    let sawFiles;

    app.use(parseAuth.AUTH_FORM_PATHS, parseAuth);
    app.use(function (req, res, next) {
      if (parseAuth.isAuthFormPath(req.path)) return next();
      return parseMultipart(req, res, next);
    });
    app.post("/sign-up", function (req, res) {
      sawFiles = req.files;
      res.sendStatus(200);
    });

    const server = await new Promise(function (resolve) {
      const server = app.listen(0, function () {
        resolve(server);
      });
    });

    try {
      const response = await new Promise(function (resolve, reject) {
        const boundary = "blot-test-boundary";
        const body =
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="upload"; filename="test.txt"\r\n` +
          `Content-Type: text/plain\r\n\r\n` +
          `should-not-be-parsed\r\n` +
          `--${boundary}--\r\n`;
        const request = http.request(
          {
            method: "POST",
            port: server.address().port,
            path: "/SIGN-UP",
            headers: {
              "Content-Type": `multipart/form-data; boundary=${boundary}`,
              "Content-Length": Buffer.byteLength(body),
            },
          },
          resolve
        );
        request.on("error", reject);
        request.end(body);
      });

      expect(response.statusCode).toBe(200);
      expect(sawFiles).toBeUndefined();
      response.resume();
    } finally {
      await new Promise(function (resolve) {
        server.close(resolve);
      });
    }
  });

  it("matches authentication locations case-insensitively in nginx", function () {
    const confDir = path.join(__dirname, "../../../../config/openresty/conf");
    const contents = fs.readFileSync(
      path.join(confDir, "blot-site.conf"),
      "utf8"
    );
    const auth = contents.match(
      /location ~\* \^\/sites\/\(log-in\|sign-up\|account\/password\)\(\/\|\$\) \{[\s\S]*?\n\}/
    )[0];

    expect(auth).toMatch(/reverse-proxy\.conf/);
    expect(auth).toMatch(/client_max_body_size 4k;/);
  });
});
