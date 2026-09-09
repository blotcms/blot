const fetch = require("node-fetch");
const fs = require("fs-extra");

const main = async (
  origin = "http://127.0.0.1/purge",
  cache_directory = "/var/instance-ssd",
  host_match = null
) => {
  if (!host_match) {
    return console.log("no host match");
  }
  const top_level_directories = await fs.readdir(cache_directory);
  const hosts_to_purge = [];

  // for each top level directory, read its contents
  for (const directory of top_level_directories) {
    const sub_directories = await fs.readdir(`${cache_directory}/${directory}`);
    for (const sub_directory of sub_directories) {
      const files = await fs.readdir(
        `${cache_directory}/${directory}/${sub_directory}`
      );
      for (const file of files) {
        // open the file as a stream and read from it until we've either read 1mb
        // or we have encountered the string 'KEY: '... newline
        const stream = fs.createReadStream(
          `${cache_directory}/${directory}/${sub_directory}/${file}`,
          { encoding: "utf8" }
        );
        let data = "";
        for await (const chunk of stream) {
          data += chunk;
          if (data.length > 1024 * 1024) break;
          if (data.includes("KEY: ")) break;
        }
        const host_line = data.split("\n").find(line => line.includes("KEY: "));
        const parsed_url = require("url").parse(host_line.split("KEY: ")[1]);
        // we don't want the port
        const host = parsed_url.host.split(":")[0];

        // hostmatch is  a string representing a host
        // if it contains a *, we want to match it as a wildcard
        // host_match = "*.blogsmith.com"
        // host_match = "www.blogsmith.com"
        // if host_match matches host, then push the host to hosts_to_purge
        if (host_match.includes("*")) {
          const regex = new RegExp(
            host_match.replace(/\./g, "\\.").replace(/\*/g, ".*")
          );
          if (regex.test(host)) hosts_to_purge.push(host);
        } else {
          if (host_match === host) hosts_to_purge.push(host);
        }
      }
    }
  }

  if (!hosts_to_purge.length) {
    return console.log("no hosts to purge");
  }

  console.log("hosts to purge", hosts_to_purge);

  // break the list of hosts into chunks of 5 and then purge them
  const chunks = hosts_to_purge.reduce(
    (chunks, host) => {
      if (chunks[chunks.length - 1].length === 5) chunks.push([]);
      chunks[chunks.length - 1].push(host);
      return chunks;
    },
    [[]]
  );

  for (const chunk of chunks) {
    const url = `${origin}?${chunk.map(host => `host=${host}`).join("&")}`;
    console.log("fetching", url);
    const response = await fetch(url);
    const data = await response.text();
    console.log("----- response ----");
    console.log(data);
    console.log();
  }
};

if (require.main === module) {
  main(undefined, undefined, process.argv[2])
    .then(console.log)
    .catch(console.error);
}
module.exports = main;
