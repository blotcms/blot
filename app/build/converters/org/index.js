var folder = require("storage/folder");
var ensure = require("helper/ensure");
var time = require("helper/time");
var extname = require("path").extname;
var Metadata = require("build/metadata");
var convert = require("./convert");
var folderStat = require("build/converters/folderStat");

function is(path) {
  return [".org"].indexOf(extname(path).toLowerCase()) > -1;
}

function toDeterministicMetadataComment(metadata) {
  const keys = Object.keys(metadata || {}).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );

  if (!keys.length) return "";

  let metadataComment = "<!--";

  keys.forEach((key) => {
    metadataComment += "\n" + key + ": " + metadata[key];
  });

  return metadataComment + "\n-->\n";
}

function mergeOrgMetadata(outerMetadata, innerMetadata) {
  const mergedMetadata = {};

  [outerMetadata, innerMetadata].forEach((source) => {
    Object.keys(source || {}).forEach((key) => {
      mergedMetadata[key] = source[key];
    });
  });

  return mergedMetadata;
}

async function read(blog, path) {
  ensure(blog, "object").and(path, "string");

  time("stat");

  let stat;

  try {
    stat = await folderStat(blog.id, path);
  } finally {
    time.end("stat");
  }

  time("readFile");

  let buffer;

  try {
    buffer = await folder.read(blog.id, path);
  } finally {
    time.end("readFile");
  }

  const contents = buffer.toString("utf-8");

  const { html: orgBody, metadata: orgMetadata } = Metadata(contents);

  const [html, yamlMetadata] = await convert(blog, orgBody);

  // Canonical metadata handling for org conversion:
  // 1. Parse org-style header metadata before conversion.
  // 2. Parse YAML metadata extracted from a leading YAML source block after conversion.
  // 3. Merge both sources with YAML taking precedence for identical keys.
  const mergedMetadata = mergeOrgMetadata(orgMetadata, yamlMetadata);
  const metadataComment = toDeterministicMetadataComment(mergedMetadata);

  return [metadataComment + html, stat];
}

// Called back with (err, html, stat); without a callback it resolves to
// [html, stat]
module.exports = { read: read, is: is, id: "org" };
