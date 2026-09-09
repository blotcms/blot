/**
 * Fixture files copied from build converter tests into each benchmark blog folder
 * so the build stage exercises multiple file types. Paths are resolved at runtime
 * so we use the same files as the converter tests (no duplication).
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../../../build/converters");

function fixture(sourceRelative, targetPath) {
  const sourcePath = path.join(ROOT, sourceRelative);
  return { sourcePath, targetPath };
}

const CONVERTER_FIXTURES = [
  // Markdown (treated as .txt by markdown converter)
  fixture(
    "markdown/tests/examples/metadata.txt",
    "/benchmark-fixtures/metadata.txt"
  ),
  fixture(
    "markdown/tests/examples/footnotes.txt",
    "/benchmark-fixtures/footnotes.txt"
  ),
  fixture(
    "markdown/tests/examples/basic-post.txt",
    "/benchmark-fixtures/basic-post.txt"
  ),
  // DOCX (requires pandoc in CI)
  fixture("docx/tests/paragraph.docx", "/benchmark-fixtures/paragraph.docx"),
  fixture("docx/tests/empty.docx", "/benchmark-fixtures/empty.docx"),
  // RTF
  fixture("rtf/tests/examples/hello.rtf", "/benchmark-fixtures/hello.rtf"),
  fixture("rtf/tests/examples/metadata.rtf", "/benchmark-fixtures/metadata.rtf"),
  // ODT
  fixture("odt/tests/paragraph.odt", "/benchmark-fixtures/paragraph.odt"),
  fixture("odt/tests/empty.odt", "/benchmark-fixtures/empty.odt"),
  // Org
  fixture("org/tests/examples/hello.org", "/benchmark-fixtures/hello.org"),
  fixture("org/tests/examples/metadata.org", "/benchmark-fixtures/metadata.org"),
  fixture("org/tests/examples/code.org", "/benchmark-fixtures/code.org"),
  // Images
  fixture("img/tests/bunny.png", "/benchmark-fixtures/bunny.png"),
  fixture("img/tests/sky.webp", "/benchmark-fixtures/sky.webp"),
  fixture("img/tests/land.avif", "/benchmark-fixtures/land.avif"),
  // Google Doc export (JSON)
  fixture("gdoc/tests/hello.gdoc", "/benchmark-fixtures/hello.gdoc"),
  fixture("gdoc/tests/metadata.gdoc", "/benchmark-fixtures/metadata.gdoc"),
  fixture("gdoc/tests/formatting.gdoc", "/benchmark-fixtures/formatting.gdoc"),
];

function getFixtures() {
  return CONVERTER_FIXTURES.filter(({ sourcePath }) => fs.existsSync(sourcePath));
}

module.exports = {
  getFixtures,
};
