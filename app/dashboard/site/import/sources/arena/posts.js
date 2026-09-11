const download = require("../../helper/download");
const lifecycle = require("../../lifecycle");
const PAGE_SIZE = 100;

module.exports = async function posts ({ slug, status }) {
  let page = 0;
  let posts = [];
  let new_posts;

  async function fetchPage (page) {
    const url = base(slug, page);
    status(`Fetching page ${page + 1} of channel`);
    lifecycle.check();
    const { data } = await download(url);
    return JSON.parse(data.toString("utf8")).contents;
  }

  new_posts = await fetchPage(page);
  posts = posts.concat(new_posts);
  page++;
  while (new_posts.length === PAGE_SIZE) {
    new_posts = await fetchPage(page);
    posts = posts.concat(new_posts);
    page++;
  }

  status(`Fetched everything on channel`);
  return posts;
};

function base (slug, page) {
  return `https://api.are.na/v2/channels/${slug}/contents?direction=desc&sort=position&per=${PAGE_SIZE}&channel_slug=${slug}&page=${page}`;
}
