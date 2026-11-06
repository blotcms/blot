const debug = require("debug")("blot:build:metadata");
const ensure = require("helper/ensure");
const YAML = require("yaml");

const alphaNumericRegEx = /^([a-zA-Z0-9\-_ ]+)$/;

function Metadata(html) {
  ensure(html, "string");

  // We try and normalize all the different ways to end a line
  // here. This is how Windows does newlines, we normalize it
  // to the unix way.
  html = html.replace(/\r\n/gm, "\n");

  // Somehow some text-editors/OSs have a single return character
  // to signify a newline. Although it doesn't seem technically correct
  // we handle this edge case here.
  html = html.replace(/\r/gm, "\n");

  let metadata = {};

  // YAML-style fenced front-matter!
  if (
    html.trim().startsWith("---") &&
    html.lastIndexOf("---") !== html.indexOf("---")
  ) {
    let frontmatter = html.trim().split("---")[1];

    try {
      // todo: investigate these options
      // and understand them
      let mixedCaseMetadata = YAML.parse(frontmatter);

      if (
        !mixedCaseMetadata ||
        typeof mixedCaseMetadata !== "object" ||
        Array.isArray(mixedCaseMetadata)
      ) {
        mixedCaseMetadata = {};
      }

      // Preserve original metadata keys as parsed.
      Object.keys(mixedCaseMetadata).forEach((mixedCaseKey) => {
        let value = mixedCaseMetadata[mixedCaseKey];

        // map 'null' values to empty strings
        // otherwise we end up with metadata properties
        // that are the string 'null' instead of simply empty
        if (value === null) value = "";

        metadata[mixedCaseKey] = value;
      });

      // Remove the metadata from the returned HTML
      html = html.trim().split("---").slice(2).join("---");

      return { html, metadata };
    } catch (e) {
      // we need to surface this error with the YAML
      return { html, metadata };
    }
  }

  let linesToRemove = [];
  let lines = html.trim().split(/\n/);

  debug(lines.length, "lines found");

  // THIS SHOULD ALSO WORK FOR HTML:
  // i.e. <p>Page: yes</p>
  for (let i = 0; i < lines.length; i++) {
    let line, key, value, firstColon, firstCharacter;

    line = lines[i];

    // if we encounter an empty line, stop looking for metadata.
    if (!line || !line.trim()) {
      debug("Line", i, "found an empty line, breaking");
      break;
    }

    firstColon = line.indexOf(":");
    firstCharacter = line.trim().charAt(0);

    if (i === 0 && firstColon === -1 && line.trim() === "<!--") {
      debug("Line", i, "found an HTML comment open tag");
      continue;
    }

    // DO NOT continue looking for metadata
    // for the following reasons
    if (
      // there is no colon on this line
      firstColon === -1 ||
      // this line is probably a markdown title
      firstCharacter === "#" ||
      // this line is probably an HTML tag
      (firstCharacter === "<" && line.slice(0, 4) !== "<!--")
    ) {
      debug("Line", i, "found a line without metadata, breaking");
      break;
    }

    // Do not continue if the first colon on the line is part of a URL
    // We want to allow URLS as part of the metadata value though
    if (
      (line.slice(firstColon - 4, firstColon) === "http" ||
        line.slice(firstColon - 5, firstColon) === "https") &&
      line.slice(firstColon + 1, firstColon + 3) === "//"
    ) {
      debug("Line", i, "found a line with a URL, breaking");
      break;
    }

    // Preserve original metadata key casing
    let originalKey = line.slice(0, firstColon).trim();
    key = originalKey.toLowerCase();

    // The key contains non-alphanumeric characters, so reject it
    if (alphaNumericRegEx.test(key) === false) break;

    // The key contains more than two spaces, so reject it
    if (key.split(" ").length > 2) break;

    value = line.slice(firstColon + 1).trim();

    debug("Line", i, "Found metadata from:", JSON.stringify(line));
    debug("Line", i, "Key", key, "value", value);

    // Extract metadata from within comments

    if (value.slice(-3) === "-->") {
      value = value.slice(0, -3).trim();
    }

    metadata[originalKey] = value;
    debug("Line", i, "will be removed");
    linesToRemove.push(i);
  }

  let linesRemoved = linesToRemove.length;

  // Remove lines with valid metadata
  while (linesToRemove.length) {
    lines.splice(linesToRemove.pop(), 1);
  }

  if (linesRemoved && lines.length) {
    // contents of HTML comment were parsed, so remove the trailing...
    if (lines[0].trim() === "<!--" && lines[1].trim() === "-->") {
      lines = lines.slice(2);
    }

    // We have the check if the first line exists again
    // because of the previous clause (which reduces lines length)
    if (lines[0] && lines[0].trim() === "-->") {
      lines = lines.slice(1);
    }

    // We have the check if the first line exists again
    // because of the previous clause (which reduces lines length)
    if (lines[0] && lines[0].trim() === "<!--") {
      lines = lines.slice(1);
    }
  }

  html = lines.join("\n");

  return {
    html: html,
    metadata: metadata,
  };
}

module.exports = Metadata;
