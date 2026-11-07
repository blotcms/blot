describe("bodyParser", function () {
  const express = require("express");
  const http = require("http");
  const bodyParser = require("helper/bodyParser");

  async function post(parser, headers, body) {
    const app = express();
    app.post("/", parser, function (req, res) {
      res.json({
        isBuffer: Buffer.isBuffer(req.body),
        body: Buffer.isBuffer(req.body) ? req.body.toString("utf8") : req.body,
      });
    });
    app.use(function (err, req, res, next) {
      res.status(err.status || 500).json({ error: err.type });
    });

    const server = await new Promise(function (resolve) {
      const server = app.listen(0, function () {
        resolve(server);
      });
    });

    try {
      return await new Promise(function (resolve, reject) {
        const request = http.request(
          {
            method: "POST",
            port: server.address().port,
            path: "/",
            headers: Object.assign(
              body === undefined
                ? {}
                : { "Content-Length": Buffer.byteLength(body) },
              headers
            ),
          },
          function (response) {
            let data = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => (data += chunk));
            response.on("end", () =>
              resolve({ status: response.statusCode, json: JSON.parse(data) })
            );
          }
        );
        request.on("error", reject);
        request.end(body);
      });
    } finally {
      server.close();
    }
  }

  const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

  it("leaves req.body as {} when a POST has no body", async function () {
    const urlencoded = await post(bodyParser.urlencoded(), {});
    expect(urlencoded.json.body).toEqual({});

    const json = await post(bodyParser.json(), {});
    expect(json.json.body).toEqual({});

    const raw = await post(bodyParser.raw(), {});
    expect(raw.json.body).toEqual({});
  });

  it("leaves req.body as {} when the content type is not the parser's", async function () {
    const response = await post(
      bodyParser.urlencoded(),
      { "Content-Type": "text/plain" },
      "a=b"
    );

    expect(response.json.body).toEqual({});
  });

  it("parses a[b]=c as a flat key, as body-parser 1 did", async function () {
    const response = await post(
      bodyParser.urlencoded({ extended: false }),
      FORM,
      "a[b]=c&d=1&d=2&e%20f=g+h"
    );

    expect(response.json.body).toEqual({
      "a[b]": "c",
      d: ["1", "2"],
      "e f": "g h",
    });
  });

  it("enforces the size limit", async function () {
    const response = await post(
      bodyParser.urlencoded({ limit: "4kb" }),
      FORM,
      "field=" + "a".repeat(4096)
    );

    expect(response.status).toBe(413);
  });

  it("defaults to the 100kb limit body-parser 1 had", async function () {
    const response = await post(
      bodyParser.urlencoded(),
      FORM,
      "field=" + "a".repeat(100 * 1024)
    );

    expect(response.status).toBe(413);
  });

  it("rejects more parameters than parameterLimit", async function () {
    const response = await post(
      bodyParser.urlencoded({ parameterLimit: 2 }),
      FORM,
      "a=1&b=2&c=3"
    );

    expect(response.status).toBe(413);
  });

  it("parses JSON and gives the raw Buffer for the types asked for", async function () {
    const json = await post(
      bodyParser.json(),
      { "Content-Type": "application/json" },
      '{"a":1}'
    );
    expect(json.json.body).toEqual({ a: 1 });

    const raw = await post(
      bodyParser.raw({ type: "application/json" }),
      { "Content-Type": "application/json" },
      '{ "a":  1 }'
    );
    expect(raw.json).toEqual({ isBuffer: true, body: '{ "a":  1 }' });
  });

  it("passes parse errors on to next", async function () {
    const response = await post(
      bodyParser.json(),
      { "Content-Type": "application/json" },
      "{nope"
    );

    expect(response.status).toBe(400);
  });
});
