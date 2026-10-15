const http = require("http");
const crypto = require("crypto");

// Runs against the test Redis server. The webhook relay publishes incoming
// webhooks to a Redis channel which connected SSE clients are subscribed to.
describe("webhooks relay", function () {
  const config = require("config");
  const client = require("models/client");
  const express = require("express");

  const CHANNEL = "webhooks:relay";
  const webhooksPath = require.resolve("clients/webhooks");

  let originalSecret;
  let originalWebhooks;
  let server;
  let url;
  let streams;

  async function until(check) {
    const deadline = Date.now() + 5000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error("timed out waiting");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function subscribers() {
    return (await client.pubSubNumSub([CHANNEL]))[CHANNEL];
  }

  // Open /connect and collect the parsed "data:" messages
  function connect(headers) {
    return new Promise(function (resolve, reject) {
      const stream = { messages: [], buffer: "" };
      const req = http.get(url + "/connect", { headers }, function (res) {
        stream.req = req;
        stream.res = res;
        res.setEncoding("utf8");
        res.on("data", function (text) {
          stream.buffer += text;
          const parts = stream.buffer.split("\n\n");
          stream.buffer = parts.pop();
          parts.forEach(function (part) {
            part.split("\n").forEach(function (line) {
              if (line.indexOf("data: ") === 0)
                stream.messages.push(JSON.parse(line.slice(6)));
            });
          });
        });
        streams.push(stream);
        resolve(stream);
      });
      req.on("error", reject);
    });
  }

  // Connect and wait until the server has subscribed to Redis
  async function connectAndSubscribe() {
    const stream = await connect({ Authorization: config.webhooks.secret });
    expect(stream.res.statusCode).toBe(200);
    await until(async () => (await subscribers()) === 1);
    return stream;
  }

  beforeEach(async function () {
    streams = [];
    originalWebhooks = require.cache[webhooksPath];
    originalSecret = config.webhooks.secret;

    // Don't start the development relay listener when requiring the module
    config.webhooks.secret = undefined;
    delete require.cache[webhooksPath];
    const router = require("clients/webhooks");
    config.webhooks.secret = "test-webhooks-secret-" + process.pid;

    const app = express();
    app.use(router);
    server = await new Promise(function (resolve) {
      const s = app.listen(0, "127.0.0.1", function () {
        resolve(s);
      });
    });
    url = "http://127.0.0.1:" + server.address().port;
  });

  afterEach(async function () {
    streams.forEach(function (stream) {
      stream.req.destroy();
    });
    await new Promise((resolve) => server.close(resolve));
    await until(async () => (await subscribers()) === 0);

    config.webhooks.secret = originalSecret;
    delete require.cache[webhooksPath];
    if (originalWebhooks) require.cache[webhooksPath] = originalWebhooks;
  });

  it("rejects /connect without the secret", async function () {
    const response = await fetch(url + "/connect");
    expect(response.status).toBe(403);

    const wrong = await fetch(url + "/connect", {
      headers: { Authorization: "wrong" },
    });
    expect(wrong.status).toBe(403);
    expect(await subscribers()).toBe(0);
  });

  it("relays a webhook's metadata and chunked body to a connected client", async function () {
    const stream = await connectAndSubscribe();
    const body = crypto.randomBytes(200 * 1024);

    const response = await fetch(url + "/clients/test/webhook?a=1", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Real-IP": "1.2.3.4",
        "X-Forwarded-For": "1.2.3.4",
        "X-Forwarded-Proto": "https",
        "X-Custom": "kept",
      },
      body,
    });
    expect(await response.text()).toBe("OK");

    await until(function () {
      const metadata = stream.messages.find((m) => m.chunk === undefined);
      const chunks = stream.messages.filter((m) => m.chunk !== undefined);
      return metadata && chunks.length === Math.ceil(metadata.bodySize / 65536);
    });

    const metadata = stream.messages.find((m) => m.chunk === undefined);
    const chunks = stream.messages.filter((m) => m.chunk !== undefined);

    expect(metadata.method).toBe("POST");
    expect(metadata.url).toBe("/clients/test/webhook?a=1");
    expect(metadata.headers.host).toBeUndefined();
    expect(metadata.headers["x-real-ip"]).toBeUndefined();
    expect(metadata.headers["x-forwarded-for"]).toBeUndefined();
    expect(metadata.headers["x-forwarded-proto"]).toBeUndefined();
    expect(metadata.headers["x-custom"]).toBe("kept");
    expect(metadata.bodySize).toBe(body.toString("base64").length);

    // Multiple chunks, in order, all for this request
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach(function (chunk, i) {
      expect(chunk.requestId).toBe(metadata.requestId);
      expect(chunk.chunkIndex).toBe(i);
      expect(chunk.totalChunks).toBe(chunks.length);
    });

    const received = Buffer.from(
      chunks.map((chunk) => chunk.chunk).join(""),
      "base64"
    );
    expect(received.equals(body)).toBe(true);
  });

  it("delivers through Redis, not process memory", async function () {
    const stream = await connectAndSubscribe();

    // Simulates a webhook received by a different process
    const message = JSON.stringify({ url: "/other-process", requestId: 1 });
    expect(await client.publish(CHANNEL, message)).toBe(1);

    await until(() => stream.messages.length === 1);
    expect(stream.messages[0]).toEqual({ url: "/other-process", requestId: 1 });
  });

  it("accepts a webhook when no client is connected", async function () {
    expect(await subscribers()).toBe(0);

    const response = await fetch(url + "/clients/test/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");

    // Give the background publish a moment to finish
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
