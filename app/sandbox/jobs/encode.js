// Writes a sharp pipeline to a temporary file and reads it back. toFile, not
// toBuffer, because the format comes from the extension exactly as it did when
// the callers wrote to the blog's folder: a .jpg holding a PNG comes out as a
// JPEG, and an extension sharp doesn't know keeps the input's format.

const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const EXTENSION = /^(\.[a-z0-9]{1,8})?$/;

function isExtension(extension) {
  return typeof extension === "string" && EXTENSION.test(extension);
}

async function encode(pipeline, extension) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "encode-"));
  const file = path.join(directory, "output" + extension);
  try {
    const info = await pipeline.toFile(file);
    return { data: await fs.readFile(file), info };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { encode, isExtension };
