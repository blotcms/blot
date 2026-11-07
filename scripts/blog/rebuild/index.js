var colors = require("colors/safe");
var get = require("../../get/blog");
var rebuild = require("sync/rebuild");

async function main() {
  const blog = await new Promise((resolve, reject) => {
    get(process.argv[2], (err, user, blog) =>
      err ? reject(err) : resolve(blog)
    );
  });

  const options = {};

  try {
    await rebuild(blog.id, options);
  } catch (err) {
    console.error(colors.red("Error:", err.message));
    return process.exit(1);
  }

  process.exit();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
