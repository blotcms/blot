// Should only run on my machine, transforms the text-file
// which is written by humans into JSON to be read by machines
// It will build the images inside the avatars directory into
// thumbnails. This could be extended to fetch other data
// about sites featured on the homepage, like template used...

const THUMBNAIL_SIZE = 96;
const JPEG_QUALITY = 100;
const { toUnicode } = require("helper/punycode");

const sharp = require("sharp");
const fs = require("fs-extra");
const { parse } = require("url");
const { join } = require("path");

const config = require("config");
const avatarDirectory = __dirname + "/avatars";
const outputDirectory = join(__dirname, "../../views/images/featured");
const verifySiteIsOnline = require("./verifySiteIsOnline");
const fetchSubscriptionDuration = require("./fetchSubscriptionDuration");

if (require.main === module) {
  (async () => {
    const sites = await build();
    await fs.outputJson(__dirname + "/featured.json", sites, { spaces: 2 });
    // purge the cached version of the featured sites
    await fs.remove(config.data_directory + "/featured");
    process.exit();
  })();
}

async function build() {
  const avatars = (await fs.readdir(avatarDirectory)).filter(
    (i) => !i.startsWith(".")
  );

  let sites = (await fs.readFile(__dirname + "/sites.txt", "utf-8"))
    .split("\n")
    .filter((i) => i)
    .map((line) => {
      var words = line.split(" ");
      var link = "https://" + words[0];
      var rest = words.slice(1).join(" ");
      var parts = rest.split(",").map((p) => p.trim());
      var name = parts[0];
      var tenureStartYear = null;
      var bioPart = parts.slice(1).join(", ");
      if (parts.length >= 2 && /^\d{4}$/.test(parts[parts.length - 1])) {
        tenureStartYear = parseInt(parts[parts.length - 1], 10);
        bioPart = parts.slice(1, -1).join(", ");
      }
      var bio = tidy(bioPart);
      var host = toUnicode(parse(link).host);

      if (!avatars.find((i) => i.startsWith(host)))
        throw new Error("Missing avatar for " + host);

      return {
        link,
        host,
        name,
        bio,
        tenureStartYear,
        avatar: join(
          avatarDirectory,
          avatars.find((i) => i.startsWith(host))
        ),
      };
    });

  // if there are some avatars without a corresponding site
  // log them and remove them from the list
  const missingAvatars = avatars.filter(
    (avatar) => !sites.find((site) => avatar.startsWith(site.host))
  );

  // remove the avatars without a corresponding site
  for (let avatar of missingAvatars) {
    console.log("Removing avatar without corresponding site", avatar);
    await fs.remove(join(avatarDirectory, avatar));
  }

  sites = await Promise.all(
    sites.map(async (site) => {
      const isOnline = await verifySiteIsOnline(site.host);

      if (!isOnline) return null;

      let tenure;
      if (site.tenureStartYear != null) {
        const startMs = Date.UTC(site.tenureStartYear, 0, 1);
        tenure = Date.now() - startMs;
      } else {
        tenure = await fetchSubscriptionDuration(site.host);
      }

      // tenureStartYear is dropped from the result

      const { tenureStartYear, ...rest } = site;
      return {
        ...rest,
        tenure,
        tenure_label: formatTenureLabel(tenure),
      };
    })
  ).then((sites) => sites.filter((i) => i));

  return await generateImages(sites);
}

function formatTenureLabel(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;

  const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
  const completedMonths = Math.floor(durationMs / ONE_MONTH_MS);
  const months = Math.max(1, completedMonths);

  if (months < 12) {
    return `this year`;
  }

  const years = Math.max(1, Math.floor(months / 12));
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

const tidy = (bio) => {
  // if the bio ends with 'based in...' or 'from ...'
  // remove everything after that
  bio = bio.trim();

  const basedIn = bio.indexOf(" based in ");

  if (basedIn > -1) {
    bio = bio.slice(0, basedIn);
  }

  const from = bio.indexOf(" from ");

  if (from > -1) {
    bio = bio.slice(0, from);
  }

  return bio;
};

async function generateImages(sites) {
  await fs.ensureDir(outputDirectory);

  const existingImages = new Set(
    (await fs.readdir(outputDirectory).catch(() => [])).filter((file) =>
      file.endsWith(".jpg")
    )
  );
  const generatedImages = new Set();

  for (let site of sites) {
    const filename = site.host + ".jpg";
    const path = join(outputDirectory, filename);
    await sharp(site.avatar)
      .resize({
        width: THUMBNAIL_SIZE,
        height: THUMBNAIL_SIZE,
        fit: sharp.fit.cover,
        position: sharp.strategy.entropy,
      })
      .toFormat("jpeg")
      .jpeg({
        quality: JPEG_QUALITY,
      })
      .toFile(path);

    site.image = "/images/featured/" + filename;
    generatedImages.add(filename);
    delete site.avatar;
  }

  const obsolete = [...existingImages].filter(
    (file) => !generatedImages.has(file)
  );
  for (const file of obsolete) {
    await fs.remove(join(outputDirectory, file));
  }

  await fs.outputFile(
    __dirname + "/sites.filtered.txt",
    (await fs.readFile(__dirname + "/sites.txt", "utf-8"))
      .split("\n")
      .filter((i) => i)
      .filter((line) => sites.find((site) => line.includes(site.host)))
      .join("\n"),
    "utf-8"
  );

  await fs.outputFile(
    __dirname + "/sites.missing.txt",
    (await fs.readFile(__dirname + "/sites.txt", "utf-8"))
      .split("\n")
      .filter((i) => i)
      .filter((line) => !sites.find((site) => line.includes(site.host)))
      .join("\n"),
    "utf-8"
  );

  return {
    image_size: THUMBNAIL_SIZE / 2,
    sites,
  };
}
