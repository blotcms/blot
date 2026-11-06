const fs = require("fs-extra");
const directory = __dirname + "/themes";
const titleCase = require("helper/titlecase");
const MinifyCSS = require("clean-css");

fs.outputJsonSync(
  __dirname + "/index.json",
  fs
    .readdirSync(directory)
    .map((name) => {
      return { name, path: directory + "/" + name };
    })
    .concat(
      fs.readdirSync(directory + "/base16").map((name) => {
        return { name, path: directory + "/base16/" + name };
      })
    )
    .filter((i) => i.name.endsWith(".css"))
    .sort(function (a, b) {
      var textA = a.name.toUpperCase();
      var textB = b.name.toUpperCase();
      return textA < textB ? -1 : textA > textB ? 1 : 0;
    })
    .map(({ name, path }) => {
      const minimize = new MinifyCSS({ level: 2 });
      const id = name.slice(0, -".css".length);
      const contents = fs.readFileSync(path, "utf8");

      // https://css-tricks.com/snippets/css/make-pre-text-wrap/
      const input =
        contents.replace(/\/\*!/g, "/*") +
        `
pre code.hljs {
  display: block;
  overflow: auto;
  padding: 1em;
  margin: 1em 0;
  white-space: pre-wrap;       
  white-space: -moz-pre-wrap;  
  white-space: -pre-wrap;      
  white-space: -o-pre-wrap;    
  word-wrap: break-word;       
}

code.hljs, .hljs {padding: 0;margin:0}
`;

      const styles = minimize.minify(input).styles;
      const title = titleCase(id.split("-").join(" "));

      const bgregex = /background(?:-color)?:\s?([#0-9a-zA-Z]+)[;]?/gm;
      const cregex = /[^-]color:\s?([#0-9a-zA-Z]+)[;]?/gm;

      let background;
      let colors;

      try {
        background = [...input.matchAll(bgregex)][0][1];
        if (background.endsWith(";")) background = background.slice(0, -1);
      } catch (e) {}

      if (!background) console.log("missing background:", path);

      const tags = [lightOrDark(background)];

      try {
        // This is gorgeous code!
        colors = [
          ...new Set(
            [...input.matchAll(cregex)]
              .map((i) => i[1])
              .filter(
                (i) =>
                  ![
                    "inherit",
                    "highlight",
                    "rgba",
                    "hue",
                    "saturation",
                    "fg",
                  ].includes(i.toLowerCase())
              )
          ),
        ];
      } catch (e) {}

      if (!colors.length) console.log("missing colors:", path);

      return {
        name: title,
        id,
        tags,
        styles,
        background,
        colors,
      };
    }),
  { spaces: 2 }
);

function lightOrDark(color) {
  var r, g, b, hsp;
  // Check the format of the color, HEX or RGB?
  if (color.match(/^rgb/)) {
    // If HEX --> store the red, green, blue values in separate variables
    color = color.match(
      /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*(\d+(?:\.\d+)?))?\)$/
    );

    r = color[1];
    g = color[2];
    b = color[3];
  } else {
    // If RGB --> Convert it to HEX: http://gist.github.com/983661
    color = +("0x" + color.slice(1).replace(color.length < 5 && /./g, "$&$&"));

    r = color >> 16;
    g = (color >> 8) & 255;
    b = color & 255;
  }

  // HSP equation from http://alienryderflex.com/hsp.html
  hsp = Math.sqrt(0.299 * (r * r) + 0.587 * (g * g) + 0.114 * (b * b));

  // Using the HSP value, determine whether the color is light or dark
  if (hsp > 127.5) {
    return "light";
  } else {
    return "dark";
  }
}
