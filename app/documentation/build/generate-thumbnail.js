const config = require("config");
const sharp = require("sharp");
const hashFile = require("helper/hashFile");
const { extname, join } = require("path");
const fs = require("fs-extra");
const hashString = require("helper/hash");
const TMP_DIRECTORY = config.tmp_directory;

module.exports = async function generateThumbnail(
  from,
  to,
  { width = 320 } = {}
) {
  if (from.includes(".mobile.")) return;

  const options = { width };
  const extension = extname(to);
  const hash = await hashFile(from);
  const optionsHash = hashString(
    Object.entries(options)
      .map(([key, value]) => `${key}-${value}`)
      .join("-")
  );
  const cachedFilePath = join(
    TMP_DIRECTORY,
    `documentation-thumbs/${hash}-${optionsHash}${extension}`
  );

  try {
    await fs.copy(cachedFilePath, to);
    return;
  } catch (e) {
    // do nothing
  }

  try {
    await sharp(from).resize(options).toFile(to);

    await fs.copy(to, cachedFilePath);
  } catch (e) {}
};
