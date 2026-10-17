// Read a node-fetch response body into a Buffer, but never more than
// `maxBytes`. The remote server chooses these asset URLs, so we cannot let it
// stream an unbounded body into the shared build process. A declared
// Content-Length over the limit is rejected before reading; the running count
// aborts a body that lies about (or omits) its length.
async function readLimitedBody(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    destroy(response);
    return null;
  }

  const chunks = [];
  let total = 0;

  try {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > maxBytes) {
        destroy(response);
        return null;
      }
      chunks.push(chunk);
    }
  } catch (err) {
    return null;
  }

  return Buffer.concat(chunks);
}

function destroy(response) {
  if (response && response.body && typeof response.body.destroy === "function") {
    response.body.destroy();
  }
}

module.exports = { readLimitedBody };
