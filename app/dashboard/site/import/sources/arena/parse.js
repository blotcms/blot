const lifecycle = require("dashboard/site/import/lifecycle");
const download = require("../../helper/download");
const { join, extname } = require("path");
const moment = require("moment");
const fs = require("fs-extra");
const sharp = require("sharp");
const async = require("async");
const helper = require("dashboard/site/import/helper");
const sanitize = require("./sanitize");

async function parse({ outputDirectory, posts, status }) {
  status = typeof status === "function" ? status : () => {};
  if (posts.length === 0) {
    status("No channel items were found");
    return;
  }

  let done = 0;
  // A writer reserves paths as it goes. Sharing it across the channel prevents
  // two blocks with the same title from silently replacing one another.
  const write = helper.write.createWriter();

  for (const item of posts) {
    lifecycle.check();
    const label =
      (item && (item.title || item.generated_title || item.id)) || "Untitled";
    status(`(${++done}/${posts.length}) Processing ${label}`);
    try {
      if (item.class === "Image") {
        await image(item, outputDirectory);
      } else if (item.class === "Link") {
        await link(item, outputDirectory);
      } else if (item.class === "Text") {
        await text(item, outputDirectory, write);
      } else {
        status(`Cannot process Are.na block ${label}`);
      }
    } catch (error) {
      lifecycle.check();
      status(`Failed to process Are.na block ${label}: ${error.message}`);
      console.error("Failed to process Are.na block", label, error);
    }
  }
}

function normalizeText(item) {
  const entry = {
    title: item.title || item.generated_title || "Untitled",
    html: item.content,
    draft: item.visibility !== "public",
  };

  if (item.created_at) {
    entry.dateStamp = Date.parse(item.created_at);
    entry.created = Date.parse(item.created_at);
  }
  if (item.updated_at) entry.updated = Date.parse(item.updated_at);

  // Are.na API responses do not consistently include the block URL.
  if (item.url) entry.permalink = item.url;
  else if (item.id) entry.permalink = `https://www.are.na/block/${item.id}`;

  const description = item.description;
  if (description && description !== item.content) entry.summary = description;
  if (item.source && item.source.url && item.source.url !== entry.permalink) {
    entry.metadata = { source: item.source.url };
  }

  return entry;
}

function text(item, outputDirectory, write) {
  return new Promise((resolve, reject) => {
    async.waterfall(
      [
        (next) => next(null, normalizeText(item)),
        helper.determine_path(outputDirectory),
        helper.download_pdfs,
        helper.download_images,
        helper.convert_to_markdown,
        helper.insert_metadata,
        write,
      ].map(lifecycle.guard),
      (error) => (error ? reject(error) : resolve())
    );
  });
}

async function link(item, outputDirectory) {
  const createdDate = new Date(item.created_at);
  const created = createdDate.valueOf();
  const draft = item.visibility !== "public";
  const title = item.source.title || item.title || "Untitled";
  const url = item.source.url;
  const name = `${sanitize(title)}.webloc`;

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>URL</key>
  <string>${url}</string>
</dict>
</plist>
`;

  const path = getPath({ outputDirectory, draft, name, created });
  lifecycle.check();
  await fs.outputFile(path, content, "utf-8");
  await fs.utimes(path, createdDate, createdDate);
}

async function image(item, outputDirectory) {
  const { data } = await download(item.image.original.url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; Blot/1.0; +https://blot.im)",
      Referer: "https://www.are.na/",
      Accept: "image/*,*/*;q=0.8",
    },
  });
  lifecycle.check();

  const title = item.title || item.generated_title || "Untitled";

  // TODO, take advantage of item.source to show where the
  // image was downloaded from
  const createdDate = new Date(item.created_at);
  const created = createdDate.valueOf();
  const draft = item.visibility !== "public";

  const extension =
    extname(item.image.filename) ||
    "." + (await sharp(data).metadata()).format;

  const name = sanitize(title) + extension;

  const path = getPath({ outputDirectory, draft, name, created });
  lifecycle.check();
  await fs.outputFile(path, data);
  await fs.utimes(path, createdDate, createdDate);
}

function getPath({ outputDirectory, draft, name, created }) {
  return join(
    outputDirectory,
    (draft ? "[draft]" : "") + moment(created).format("YYYY-MM-DD") + " " + name
  );
}

module.exports = parse;
module.exports.normalizeText = normalizeText;
