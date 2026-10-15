const config = require("config");
const express = require("express");
const EventSource = require("eventsource");
const fetch = require("node-fetch");
const clfdate = require("helper/clfdate");
const querystring = require("querystring");
const bodyParser = require("body-parser");
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
  res.send(req.query.challenge);
});

server.use(
  bodyParser.raw({
    inflate: true,
    limit: maxFileSize,
    type: "application/*",
  }),
  (req, res) => {
    res.send("OK");

    const headers = req.headers;

    delete headers.host;
    delete headers["x-real-ip"];
    delete headers["x-forwarded-for"];
    delete headers["x-forwarded-proto"];

    const body = req.body ? req.body.toString("base64") : null;

    const requestId = Date.now() + Math.random();

    const message = {
      url: req.url,
      headers,
      requestId,
      method: req.method,
      bodySize: body ? body.length : 0, // Include the size of the body
    };

    publish(message, body).catch((err) => {
      console.error(clfdate(), "Webhooks error publishing", requestId, err);
    });
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

  // Send the body in chunks so no single message is large. Commands on one
  // connection are handled in order, so the chunks arrive in sequence
  const totalChunks = Math.ceil(body.length / CHUNK_SIZE);

  for (let i = 0; i < totalChunks; i++) {
    await client.publish(
      CHANNEL,
      JSON.stringify({
        chunk: body.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
        requestId: message.requestId,
        chunkIndex: i,
        totalChunks,
      })
    );
  }

  console.log(clfdate(), `Delivered ${totalChunks} chunks for`, message.requestId);
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
        console.error(clfdate(), `No metadata found for requestId: ${requestId}`);
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
      if (requestState.bodyChunks.filter(Boolean).length === parsed.totalChunks) {
        const completeBody = requestState.bodyChunks.join("");

        console.log(clfdate(), `Webhooks received complete body for requestId: ${requestId}`);

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
        console.error(clfdate(), "Received metadata without a requestId:", parsed);
        return;
      }

      console.log(clfdate(), `Webhooks received metadata for requestId: ${requestId}`);

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

      if (metadata.method !== "HEAD" && metadata.method !== "GET" && metadata.body) {
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

if (config.environment === "development" && config.webhooks.relay_host && config.webhooks.secret) {
  listen({ host: config.webhooks.relay_host });
}

module.exports = server;