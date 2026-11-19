// Sets how a site appears on Discover (#2639): a name, a bio and an avatar
// shown in place of the site's own, for sites the maintainer added by hand.
//
//   node scripts/discover/profile.js <site> [--name <name>] [--bio <bio>]
//     [--avatar <URL or file>] [--crop centre|top|bottom|left|right]
//     [--reset]
//
// <site> is a host (example.com), a handle or a blog ID. The avatar is
// stored as a square, so --crop says where in a photo which isn't square to
// take it from (centre unless given). An avatar URL must be on Blot: an image
// on the CDN, or a file at a Blot site's own address (see
// models/discover/profile.js); anything else, download and pass the file.
// An empty --name or --bio goes back to the site's own. --reset removes the
// whole profile. With no options it prints the profile.

const fs = require("fs-extra");
const Blog = require("models/blog");
const Discover = require("models/discover");
const blogForHost = require("documentation/featured/blogForHost");

function usage(message) {
  if (message) console.error(message + "\n");
  console.error(
    "Usage: node scripts/discover/profile.js <site> [--name <name>] [--bio <bio>]\n" +
      "  [--avatar <URL or file>] [--crop centre|top|bottom|left|right] [--reset]"
  );
  process.exit(2);
}

function parse(argv) {
  const options = { site: null };
  const values = ["--name", "--bio", "--avatar", "--crop"];

  for (let i = 0; i < argv.length; i++) {
    if (values.includes(argv[i]) && argv[i + 1] !== undefined) {
      options[argv[i].slice(2)] = argv[++i];
    } else if (argv[i] === "--reset") {
      options.reset = true;
    } else if (!argv[i].startsWith("--") && !options.site) {
      options.site = argv[i];
    } else {
      usage("Unknown argument: " + argv[i]);
    }
  }

  if (!options.site) usage();
  if (options.crop && !Discover.profile.POSITIONS.includes(options.crop))
    usage("--crop must be one of " + Discover.profile.POSITIONS.join(", "));

  return options;
}

async function find(site) {
  if (site.startsWith("blog_")) return Blog.get({ id: site });
  if (site.includes(".")) return blogForHost(site.replace(/^https?:\/\//, ""));
  return Blog.get({ handle: site });
}

async function main(argv) {
  const options = parse(argv);
  const blog = await find(options.site);

  if (!blog) throw new Error("No site for " + options.site);

  if (options.reset) {
    await Discover.profile.remove(blog.id);
    console.log("Removed the profile of", blog.id);
    return;
  }

  if (options.name !== undefined || options.bio !== undefined)
    await Discover.profile.set(blog.id, {
      name: options.name,
      bio: options.bio,
    });

  if (options.avatar) {
    const crop = { position: options.crop };

    if (/^https?:\/\//.test(options.avatar))
      await Discover.profile.setAvatarFromURL(blog.id, options.avatar, crop);
    else
      await Discover.profile.setAvatarData(
        blog.id,
        await fs.readFile(options.avatar),
        crop
      );
  }

  console.log(blog.id, (await Discover.profile.get(blog.id)) || "no profile");
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}

module.exports = { main };
