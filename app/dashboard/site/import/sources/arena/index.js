// https://www.are.na/alex-singh/assorted-design-references
// https://www.are.na/james-hicks/vaporwave
// https://www.are.na/steve-k/neon-plants-and-lava-lamps
// https://www.are.na/michael-duong/urban-outfitters-tarkovsky

const Posts = require("./posts");
const parse = require("./parse");
const download = require("../../helper/download");
const lifecycle = require("../../lifecycle");
const fs = require("fs-extra");
const { join } = require("path");

async function main({ slug, outputDirectory, status }) {
  status("Fetching posts from Are.na channel " + slug);
  const { data } = await download(`https://api.are.na/v2/channels/${slug}`);
  const json = JSON.parse(data.toString("utf8"));
  lifecycle.check();
  
  const {
    metadata: { description },
    owner,
  } = json;

  await fs.outputFile(
    join(outputDirectory, "_description.txt"),
    `${description}

https://www.are.na/${owner.slug}/${slug}`
  );

  const posts = await Posts({ slug, status });
  await parse({ outputDirectory, posts, status });
}

module.exports = main;
