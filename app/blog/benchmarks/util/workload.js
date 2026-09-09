const { getFixtures } = require("./fixtures");

function buildWorkload(config, blogs, rng) {
  const files = [];
  const filesPerSite = new Array(blogs.length).fill(0);

  for (let index = 0; index < config.files; index++) {
    const blogIndex = index % blogs.length;
    filesPerSite[blogIndex] += 1;

    const depth = 1 + Math.floor(rng() * 3);
    const segments = [];

    for (let i = 0; i < depth; i++) {
      segments.push(randomWord(rng, 6 + Math.floor(rng() * 8)));
    }

    const slug = `benchmark-${blogIndex}-${index}-${randomWord(rng, 8)}`;
    const filePath = `/${segments.join("/")}/${slug}.txt`;

    files.push({
      blogIndex,
      path: filePath,
      content: makeEntryContent({ rng, slug, blogIndex, index }),
    });
  }

  const fixtures = getFixtures();
  for (let blogIndex = 0; blogIndex < blogs.length; blogIndex++) {
    for (const { sourcePath, targetPath } of fixtures) {
      files.push({ blogIndex, path: targetPath, sourcePath });
      filesPerSite[blogIndex] += 1;
    }
  }

  return {
    files,
    filesPerSite,
    fixtureCount: fixtures.length,
  };
}

function makeEntryContent({ rng, slug, blogIndex, index }) {
  const sentenceCount = 3 + Math.floor(rng() * 5);
  const sentences = [];

  for (let i = 0; i < sentenceCount; i++) {
    sentences.push(randomSentence(rng));
  }

  return [
    `Title: Benchmark ${blogIndex}-${index}`,
    `Link: /${slug}`,
    "",
    sentences.join(" "),
    "",
  ].join("\n");
}

function randomSentence(rng) {
  const words = [];
  const wordCount = 8 + Math.floor(rng() * 10);

  for (let index = 0; index < wordCount; index++) {
    words.push(randomWord(rng, 3 + Math.floor(rng() * 7)));
  }

  const first = words[0];
  words[0] = first[0].toUpperCase() + first.slice(1);

  return `${words.join(" ")}.`;
}

function randomWord(rng, length) {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let output = "";

  while (output.length < length) {
    const idx = Math.floor(rng() * chars.length);
    output += chars[idx];
  }

  return output;
}

module.exports = {
  buildWorkload,
  makeEntryContent,
  randomSentence,
  randomWord,
};
