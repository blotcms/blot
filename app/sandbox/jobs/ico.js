// Packs PNG images into one ICO file, storing each PNG as it is. Every
// browser, and Windows since Vista, reads PNG entries in an ICO, so there is
// no need to re-encode them as bitmaps. Replaces to-ico, whose old jimp
// dependency tree carried a dozen security advisories.

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const HEADER_SIZE = 6;
const ENTRY_SIZE = 16;
const MAX_SIZE = 256;

// The width and height from a PNG's IHDR chunk, which always comes first
function pngSize(png) {
  if (
    !Buffer.isBuffer(png) ||
    png.length < 24 ||
    !png.subarray(0, 8).equals(PNG_SIGNATURE) ||
    png.toString("latin1", 12, 16) !== "IHDR"
  )
    throw new Error("not a PNG");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || height < 1 || width > MAX_SIZE || height > MAX_SIZE)
    throw new Error("ICO images must be 1 to 256 pixels across");
  return { width, height };
}

module.exports = function toIco(pngs) {
  if (!Array.isArray(pngs) || !pngs.length)
    throw new Error("no images for the ICO");

  const sizes = pngs.map(pngSize);
  const header = Buffer.alloc(HEADER_SIZE + ENTRY_SIZE * pngs.length);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 is an icon, 2 a cursor
  header.writeUInt16LE(pngs.length, 4);

  let offset = header.length;
  pngs.forEach((png, i) => {
    const entry = HEADER_SIZE + ENTRY_SIZE * i;
    // 0 stands for 256
    header.writeUInt8(sizes[i].width % MAX_SIZE, entry);
    header.writeUInt8(sizes[i].height % MAX_SIZE, entry + 1);
    header.writeUInt8(0, entry + 2); // no palette
    header.writeUInt8(0, entry + 3); // reserved
    header.writeUInt16LE(1, entry + 4); // colour planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });

  return Buffer.concat([header, ...pngs]);
};
