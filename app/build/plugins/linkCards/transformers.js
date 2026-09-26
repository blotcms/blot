const Transformer = require("helper/transformer");
const TransformerKeys = require("helper/transformer/keys");
const client = require("models/client");

function createTransformer(blogID, name) {
  if (!blogID || !name) return null;

  try {
    const transformer = new Transformer(blogID, name);
    transformer._blogID = blogID;
    transformer._name = name;
    return transformer;
  } catch (err) {
    return null;
  }
}

function transformerLookup(transformer, src, transformFactory, fallback) {
  return new Promise((resolve) => {
    const handleFallback = () => {
      if (!fallback) return resolve(null);
      Promise.resolve()
        .then(() => fallback())
        .then((result) => resolve(result || null))
        .catch(() => resolve(null));
    };

    if (!transformer) {
      return handleFallback();
    }

    try {
      transformer.lookup(src, transformFactory, async (err, result) => {
        if (!err && result) {
          return resolve(result);
        }

        const cached = await readTransformerResult(transformer, src);
        if (cached) {
          return resolve(cached);
        }

        handleFallback();
      });
    } catch (err) {
      readTransformerResult(transformer, src)
        .then((cached) => {
          if (cached) return resolve(cached);
          handleFallback();
        })
        .catch(() => handleFallback());
    }
  });
}

async function readTransformerResult(transformer, src) {
  if (!transformer || !transformer._blogID || !transformer._name) {
    return null;
  }

  let keys;

  try {
    keys = TransformerKeys(transformer._blogID, transformer._name);
  } catch (err) {
    return null;
  }

  // models/client is a promise-based node-redis client (RESP3, no legacy
  // callback mode) - it must be awaited. Passing a callback here, as this
  // used to, means the callback never fires and the caller hangs until the
  // plugin's 10 minute timeout.
  try {
    const hash = await client.get(keys.url.content(src));
    if (!hash) return null;

    const payload = await client.get(keys.content(hash));
    if (!payload) return null;

    return JSON.parse(payload) || null;
  } catch (err) {
    return null;
  }
}

module.exports = {
  createTransformer,
  transformerLookup,
  readTransformerResult,
};
