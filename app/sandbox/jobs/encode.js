// Writes a sharp pipeline to a temporary file and reads it back. toFile, not
// toBuffer, because the format comes from the extension exactly as it did when
// the callers wrote it: a .jpg holding a PNG comes out as a JPEG, and an empty
// extension, or one sharp doesn't know, keeps the input's format.

const fs = require("fs/promises");
const os = require("os");
const path = require("path");

// The most pixels sharp decodes from one input in these jobs (its default is
// 268 MP, about 1 GiB of RGBA). A larger image fails like one that can't be
// decoded: the same sharp error as a corrupt file, so the callers' handling is
// unchanged (no thumbnail, an image left as it was written). template-image and
// favicon have the same limit.
const MAX_INPUT_PIXELS = 100 * 1000 * 1000;

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

module.exports = { encode, isExtension, MAX_INPUT_PIXELS };
