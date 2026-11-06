const fs = require("fs-extra");
const regex = /^fonts\s+{\s+([^}]+)}/gm;
const { extname } = require("path");
const normalize = (str) => str.replace(/\W/g, "").toLowerCase().trim();

const WEIGHTS = {
  Thin: 100,
  "Extra Light": 200,
  "Ultra Light": 200,
  Light: 300,
  Normal: 400,
  Regular: 400,
  Book: 400,
  Medium: 500,
  "Semi Bold": 600,
  "Demi Bold": 600,
  Bold: 700,
  "Extra Bold": 800,
  "Ultra Bold": 800,
  Black: 900,
  Heavy: 900,
};

fs.readdirSync(__dirname + "/data")
  .map((name) => __dirname + "/data/" + name)
  .filter(
    (path) => !path.endsWith("-result") && fs.statSync(path).isDirectory()
  )
  .forEach((path) => build(path));

function build(directory) {
  const output = directory + "-result";

  fs.emptyDirSync(output);

  if (fs.existsSync(directory + "/METADATA.pb"))
    return withMetadata(directory, output);

  const fontFiles = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".ttf") || name.endsWith(".otf"));

  fontFiles.forEach((filename) => {
    const italic =
      normalize(filename).includes("italic") ||
      normalize(filename).includes("oblique");

    const weight =
      WEIGHTS[
        Object.keys(WEIGHTS)
          .filter((weight) => {
            return normalize(filename).includes(normalize(weight));
          })
          .sort((a, b) => {
            if (a.length > b.length) return -1;
            if (a.length < b.length) return 1;
            return 0;
          })[0] || "Normal"
      ];

    const name = weight + (italic ? "-italic" : "") + extname(filename);

    fs.copySync(directory + "/" + filename, output + "/" + name);
  });
}

function withMetadata(directory, output) {
  const metadata = fs.readFileSync(directory + "/METADATA.pb", "utf-8");

  const fonts = [...metadata.matchAll(regex)]
    .map((i) => i[1])
    .map((str) => {
      const res = {};
      str
        .split("\n")
        .map((line) => line.trim())
        .forEach((line) => {
          const key = line.split(":")[0];

          let value = line.split(":").slice(1).join(":").trim();

          if (value.startsWith('"') && value.endsWith('"'))
            value = value.slice(1, -1);

          if (key && value) res[key] = value;
        });

      return res;
    });

  fonts.forEach((font) => {
    console.log(font);
    const weight = font.weight;
    const italic = font.style === "italic";
    const name = weight + (italic ? "-italic" : "") + extname(font.filename);
    fs.copySync(directory + "/" + font.filename, output + "/" + name);
  });
}
