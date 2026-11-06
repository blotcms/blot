const sharp = require("sharp");

const images = [
  {
    name: "blast@2x.jpg",
    color: { r: 255, g: 0, b: 0 },
  },
  {
    name: "bunny.png",
    color: { r: 0, g: 255, b: 0 },
  },
  {
    name: "byrne.gif",
    color: { r: 0, g: 0, b: 255 },
  },
  {
    name: "laptop.tiff",
    color: { r: 255, g: 255, b: 0 },
  },
  {
    name: "sky.webp",
    color: { r: 0, g: 255, b: 255 },
  },
  {
    name: "land.avif",
    color: { r: 255, g: 255, b: 255 },
  },
  {
    name: "photo.heic",
    color: { r: 0, g: 125, b: 125 },
  },
  {
    name: "image.heif",
    color: { r: 125, g: 0, b: 125 },
  },
];

async function generateImages() {
  for (const image of images) {
    try {
      await sharp({
        create: {
          width: 1,
          height: 1,
          channels: 4,
          background: { ...image.color, alpha: 1 },
        },
      }).toFile(`${__dirname}/${image.name}`);
    } catch (err) {
      console.error(`Error generating ${image.name}:`, err);
    }
  }
}

generateImages();
