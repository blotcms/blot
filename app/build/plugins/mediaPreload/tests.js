const cheerio = require("cheerio");
const { render } = require("./index.js");

function runPlugin(html) {
  return new Promise((resolve, reject) => {
    const $ = cheerio.load(html, { decodeEntities: false });
    render($, (err) => {
      if (err) return reject(err);
      resolve($.html());
    });
  });
}

describe("media preload plugin", function () {
  it('adds preload="metadata" to audio and video without preload', async function () {
    const html = [
      "<audio controls src='/audio/example.mp3'></audio>",
      "<video controls src='/video/example.mp4'></video>",
    ].join("");

    const output = await runPlugin(html);

    expect(output).toContain(
      '<audio controls="" src="/audio/example.mp3" preload="metadata"></audio>'
    );
    expect(output).toContain(
      '<video controls="" src="/video/example.mp4" preload="metadata"></video>'
    );
  });

  it("preserves existing preload attributes", async function () {
    const html = [
      "<audio controls preload='none' src='/audio/custom.mp3'></audio>",
      "<video controls preload='auto' src='/video/custom.mp4'></video>",
    ].join("");

    const output = await runPlugin(html);

    expect(output).toContain(
      '<audio controls="" preload="none" src="/audio/custom.mp3"></audio>'
    );
    expect(output).toContain(
      '<video controls="" preload="auto" src="/video/custom.mp4"></video>'
    );
  });
});
