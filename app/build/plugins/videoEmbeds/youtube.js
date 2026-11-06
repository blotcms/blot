const fetch = require("node-fetch");
const { parse } = require("url");
const config = require("config");
const cheerio = require("cheerio");
const querystring = require("querystring");
const withCallback = require("helper/withCallback");
const ERROR_MESSAGE = "Could not parse youtube video";

async function youtube(href) {
  try {
    const { query, hostname, pathname } = parse(href);

    if (!hostname || !hostname.match(/youtube.com$|youtu.be$/)) {
      throw new Error(ERROR_MESSAGE);
    }

    // Url.parse maps backslashes (used to escape) to forward
    // slashes, e.g. '/_' for some reason. We remove the forward
    // slash here, since it breaks video embeds for videos with
    // ids that contain escapable characters, e.g.
    // https://youtu.be/6orc\_lHvJKY
    const id =
      hostname === "youtu.be"
        ? pathname.slice(1).replace(/\\/g, "")
        : querystring.parse(query).v;

    if (!id) throw new Error(ERROR_MESSAGE);

    // default ratio for youtube videos
    let ratio = 56.25;

    try {
      const res = await fetch(
        "https://www.googleapis.com/youtube/v3/videos?part=player&id=" +
          id +
          "&key=" +
          config.youtube.secret
      );

      const body = await res.json();

      var $ = cheerio.load(body.items[0].player.embedHtml, null, false);

      const width = $("iframe").attr("width");
      const height = $("iframe").attr("height");
      ratio = (height / width) * 100;
    } catch (e) {}

    // we prepend a zero-width char because of a bug on mobile safari
    // where if the embed is the first child,
    // the video player will not show.
    const embedHTML = `<div style="width:0;height:0"> </div><div class="videoContainer" style="padding-bottom:${ratio}%"><iframe src="https://www.youtube-nocookie.com/embed/${id}?rel=0&wmode=transparent&rel=0&autohide=1&showinfo=0" frameborder="0" allowfullscreen></iframe></div>`;

    return embedHTML;
  } catch (e) {
    throw new Error(ERROR_MESSAGE, { cause: e });
  }
}

module.exports = withCallback(youtube);
