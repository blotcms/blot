const config = require("config");
const express = require("express");
const EventSource = require("eventsource");
const fetch = require("node-fetch");
const clfdate = require("helper/clfdate");
const querystring = require("querystring");
const bodyParser = require("helper/bodyParser");
const client = require("models/client");
const sse = require("helper/sse");

const maxFileSize = config.webhooks.client_max_body_size;

/*


Production code
---------------

This section runs on the remote server and listens for incoming webhooks from clients. It forwards the webhooks to connected clients (i.e. me developing) in real-time.

Incoming webhooks are published to a Redis channel and each connected client is subscribed to it, so the webhook and the client's stream can be served by different processes.

*/

const CHANNEL = "webhooks:relay";
const CHUNK_SIZE = 64 * 1024; // 64 KB

const server = express.Router();

const stream = sse({ channel: () => CHANNEL });

server.get("/connect", function (req, res) {
  if (req.header("Authorization") !== config.webhooks.secret) {
    return res.status(403).send("Unauthorized");
  }

  console.log(clfdate(), "Webhooks client connected");
  req.on("close", function () {
    console.log(clfdate(), "Webhooks client disconnected");
  });

  stream(req, res);
});

server.get("/clients/dropbox/authenticate", (req, res) => {
  const url =
    config.protocol +
    config.webhooks.development_host +
    "/clients/dropbox/authenticate?" +
    querystring.stringify(req.query);
  res.redirect(url);
});

server.get("/clients/google-drive/authenticate", (req, res) => {
  const url =
    config.protocol +
    config.webhooks.development_host +
    "/clients/google-drive/authenticate?" +
    querystring.stringify(req.query);
  res.redirect(url);
});

// This is sent by Dropbox to verify a webhook when first added
server.get("/clients/dropbox/webhook", (req, res, next) => {
  if (!req.query || !req.query.challenge) return next();
  // Echo as plain text so the challenge can't be rendered as HTML
  res.set("Content-Type", "text/plain");
  res.set("X-Content-Type-Options", "nosniff");
  res.send(String(req.query.challenge));
});

// A relayed body is held in memory while it is read and published, so a few
// large webhooks at once could exhaust the process. Past this many in flight
// the relay answers 503 rather than queueing bodies.
const MAX_IN_FLIGHT = 2;
let inFlight = 0;

// Messages are base64 text which the client joins before decoding. Each
// chunk must therefore encode a multiple of 3 bytes, or padding would land
// in the middle of the joined string. 48 KB of bytes is 64 KB of base64.
const CHUNK_BYTES = (CHUNK_SIZE / 4) * 3;

// Only buffer the body when a development client is listening. PUBSUB NUMSUB
// counts subscribers in every process, so it covers any Node process serving
// /connect. When nobody is, or Redis can't say, the body is read and dropped.
async function hasSubscribers() {
  try {
    return (await client.pubSubNumSub([CHANNEL]))[CHANNEL] > 0;
  } catch (err) {
    console.error(clfdate(), "Webhooks error counting subscribers", err);
    return false;
  }
}

async function admit(req, res, next) {
  if (!(await hasSubscribers())) {
    // Dropbox and Google must always get OK or they stop sending webhooks.
    // Reply once the body has been read and discarded, without keeping it.
    req.on("end", () => res.send("OK"));
    req.on("error", () => {});
    req.resume();
    return;
  }

  if (inFlight >= MAX_IN_FLIGHT) {
    res.set("Retry-After", "5");
    res.set("Connection", "close");
    return res.status(503).send("Relay busy");
  }

  inFlight++;
  let released = false;
  req.releaseRelaySlot = function () {
    if (released) return;
    released = true;
    inFlight--;
  };

  // Covers a body that is aborted or rejected before relay() takes over
  res.once("close", () => {
    if (!req.relaying) req.releaseRelaySlot();
  });

  next();
}

server.use(
  admit,
  bodyParser.raw({
    inflate: true,
    limit: maxFileSize,
    type: "application/*",
  }),
  (req, res) => {
    res.send("OK");

    req.relaying = true;

    const headers = req.headers;

    delete headers.host;
    delete headers["x-real-ip"];
    delete headers["x-forwarded-for"];
    delete headers["x-forwarded-proto"];

    // body-parser leaves {} when the request had no body it parsed
    const body = Buffer.isBuffer(req.body) && req.body.length ? req.body : null;

    const requestId = Date.now() + Math.random();

    const message = {
      url: req.url,
      headers,
      requestId,
      method: req.method,
      // The size of the base64 text the chunks add up to
      bodySize: body ? Math.ceil(body.length / 3) * 4 : 0,
    };

    publish(message, body)
      .catch((err) => {
        console.error(clfdate(), "Webhooks error publishing", requestId, err);
      })
      .finally(req.releaseRelaySlot);
  }
);

async function publish(message, body) {
  const metadata = JSON.stringify(message);

  console.log(clfdate(), "Webhooks publishing metadata", metadata);

  // Publish metadata first. PUBLISH returns the number of processes
  // subscribed, so skip the body when no client is connected anywhere
  const receivers = await client.publish(CHANNEL, metadata);

  console.log(clfdate(), "Delivered metadata to", receivers, "processes");

  if (!body || !receivers) return;

  // Send the body in chunks so no single message is large, encoding each
  // as it goes so the whole base64 string never exists. Commands on one
  // connection are handled in order, so the chunks arrive in sequence
  const totalChunks = Math.ceil(body.length / CHUNK_BYTES);

  for (let i = 0; i < totalChunks; i++) {
    await client.publish(
      CHANNEL,
      JSON.stringify({
        chunk: body
          .subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)
          .toString("base64"),
        requestId: message.requestId,
        chunkIndex: i,
        totalChunks,
      })
    );
  }

  console.log(
    clfdate(),
    `Delivered ${totalChunks} chunks for`,
    message.requestId
  );
}

/*

Development code
----------------

This section runs locally when I'm developing and testing the webhooks client. It listens for events from the remote server and forwards them to the local server.

*/

const pendingRequests = new Map();

function listen({ host }) {
  const url = "https://" + host + "/connect";

  const options = { headers: { Authorization: config.webhooks.secret } };

  if (
    config.environment === "development" &&
    host === config.webhooks.server_host
  ) {
    options.https = { rejectUnauthorized: false };
  }

  const stream = new EventSource(url, options);

  console.log(clfdate(), "Webhooks subscribing to", url);

  stream.onopen = function () {
    console.log(clfdate(), "Webhooks subscribed to", url);
  };

  stream.onerror = function (err) {
    console.log(clfdate(), "Webhooks error with remote server:", err);
  };

  stream.onmessage = async function ({ data }) {
    const parsed = JSON.parse(data);

    if (parsed.chunk !== undefined) {
      // Handle chunked data on the client
      const requestId = parsed.requestId; // Ensure each request has a unique ID
      let requestState = pendingRequests.get(requestId);

      if (!requestState) {
        console.error(
          clfdate(),
          `No metadata found for requestId: ${requestId}`
        );
        return;
      }

      // Ensure bodyChunks array exists
      if (!requestState.bodyChunks) {
        requestState.bodyChunks = [];
      }

      // Store the chunk in the correct index
      requestState.bodyChunks[parsed.chunkIndex] = parsed.chunk;

      console.log(
        clfdate(),
        `Webhooks received chunk ${parsed.chunkIndex + 1}/${parsed.totalChunks} for requestId: ${requestId}`
      );

      // Check if all chunks have been received
      if (
        requestState.bodyChunks.filter(Boolean).length === parsed.totalChunks
      ) {
        const completeBody = requestState.bodyChunks.join("");

        console.log(
          clfdate(),
          `Webhooks received complete body for requestId: ${requestId}`
        );

        // Remove the request from the map after completion
        pendingRequests.delete(requestId);

        // Forward the complete request to the local server
        forwardToLocal(
          {
            ...requestState.metadata,
            body: completeBody,
          },
          requestState.metadata.headers
        );
      }
    } else {
      // Handle metadata
      const requestId = parsed.requestId; // Ensure this is part of the metadata
      if (!requestId) {
        console.error(
          clfdate(),
          "Received metadata without a requestId:",
          parsed
        );
        return;
      }

      console.log(
        clfdate(),
        `Webhooks received metadata for requestId: ${requestId}`
      );

      if (parsed.bodySize === 0) {
        // If there's no body, forward immediately
        forwardToLocal(parsed, parsed.headers);
      } else {
        // Store metadata in the pendingRequests map
        pendingRequests.set(requestId, { metadata: parsed });
      }
    }
  };

  async function forwardToLocal(metadata, headers) {
    const path = require("url").parse(metadata.url).path;

    try {
      const options = {
        headers,
        method: metadata.method,
      };

      options.headers["x-forwarded-proto"] = "https";
      options.headers["x-forwarded-host"] = config.host;
      options.headers.host = config.host;

      if (
        metadata.method !== "HEAD" &&
        metadata.method !== "GET" &&
        metadata.body
      ) {
        options.body = Buffer.from(metadata.body, "base64");
      }

      const localURL = "http://" + config.host + ":" + config.port + path;

      console.log(clfdate(), "Webhooks forwarding to", localURL);

      await fetch(localURL, options);
    } catch (e) {
      console.log(clfdate(), "Webhooks error forwarding request", e);
    }
  }
}

// node-a only: node-b would forward every notification a second time
if (
  config.environment === "development" &&
  !config.worker_child &&
  config.webhooks.relay_host &&
  config.webhooks.secret
) {
  listen({ host: config.webhooks.relay_host });
}

module.exports = server;
