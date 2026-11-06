const cheerio = require("cheerio");
const URL = require("url");

const metadataCaseInsensitive = require("helper/metadataCaseInsensitive");

const YOUTUBE_HOSTS = [
  "www.youtube.com",
  "youtube.com",
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
  "m.youtube.com",
  "youtu.be"
];

module.exports = function (metadata, html) {
  const candidates = [];
  const metadataByLowercaseKey = metadataCaseInsensitive(metadata);

  // Would be nice to resolve this relative to
  // the location of the entry so we could
  // use a relative path in the thumbnail metadata
  if (metadataByLowercaseKey.thumbnail) {
    candidates.push(metadataByLowercaseKey.thumbnail);
  }

  const $ = cheerio.load(html, { decodeEntities: false }, false);

  $("img, .videoContainer iframe").each(function () {
    try {
      // handle images
      if ($(this).is("img")) {
        const src = $(this).attr("src");

        // The img lacks an src attribute – it happens!
        if (!src) return;

        // We've already added this image as a candidate
        if (candidates.indexOf(src) > -1) return;

        candidates.push(src);
      } else {
        // handle vimeo
        const thumbnail = $(this).attr("data-thumbnail");

        if (thumbnail) {
          candidates.push(thumbnail);
          return;
        }

        // handle youtube
        const { hostname, pathname } = URL.parse($(this).attr("src"));

        // We only want to handle youtube thumbnails
        if (
          YOUTUBE_HOSTS.indexOf(hostname) === -1 ||
          pathname.indexOf("/embed/") !== 0
        ) {
          return;
        }

        const id = pathname.slice("/embed/".length);

        if (!id) {
          return;
        }

        // see here for a discussion of youtube thumbnail URLs:
        // https://stackoverflow.com/questions/2068344/how-do-i-get-a-youtube-video-thumbnail-from-the-youtube-api
        const highResThumbnail = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
        const fallbackThumbnail = `http://img.youtube.com/vi/${id}/mqdefault.jpg`;

        if (candidates.indexOf(highResThumbnail) === -1) {
          candidates.push(highResThumbnail);
          candidates.push(fallbackThumbnail);
        }
      }
    } catch (e) {}
  });

  return candidates;
};
