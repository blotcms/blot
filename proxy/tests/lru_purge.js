const fs = require("fs-extra");
const fetch = require("node-fetch");
const setup = require("./util/setup");
const { host } = require("config");

describe("cacher", function () {
  setup("./lru_purge.conf");

  it(
    "will automatically purge the cache when it fills up",
    async function () {
      const number_of_requests = 10000;
      const hosts = {};

      for (let i = 0; i < number_of_requests; i++) {
        const host = randomhost();
        const res = await fetch(
          this.origin + "/timestamp/" + i + "?host=" + host
        );
        hosts[host] = i;
        const text = await res.text();
        expect(res.status).toBe(200);
        expect(parseInt(text)).toBeGreaterThan(0);
        expect(res.headers.get("Cache-Status")).toBe("MISS");
      }

      // check that none of the files on disk are untracked by openresty shared dict
      const { message, cache } = await this.inspectCache({ verbose: true });

      // check that the missing hosts are the least recently used
      const hosts_on_disk = Object.keys(cache);

      // there are no files on disk untracked in the lua shared dictionary
      expect(message).toEqual("Cache is consistent");

      // of the files on disk, the ones missing are the least recently used
      const hosts_purged_from_disk = Object.keys(hosts)
        .filter(host => !hosts_on_disk.includes(host))
        .sort((a, b) => {
          return hosts[a] - hosts[b];
        });

      const average_index_of_purged_hosts =
        hosts_purged_from_disk.reduce((acc, host) => {
          return acc + hosts[host];
        }, 0) / hosts_purged_from_disk.length;

      const average_index_of_hosts_on_disk =
        hosts_on_disk.reduce((acc, host) => {
          return acc + hosts[host];
        }, 0) / hosts_on_disk.length;

      console.log(
        "average_index_of_purged_hosts",
        average_index_of_purged_hosts
      );
      console.log(
        "average_index_of_hosts_on_disk",
        average_index_of_hosts_on_disk
      );
      expect(average_index_of_purged_hosts).toBeGreaterThan(
        average_index_of_hosts_on_disk
      );
    },
    2 * 60 * 1000 // 2 minutes
  );
});

const letters = "abcdef";
const host_length = 5;

// will generate one of 7776 possible hosts
// e.g. aaaaa.com, aaaab.com, aaaac.com, etc.
function randomhost () {
  let host = "";
  for (let i = 0; i < host_length; i++) {
    host += letters[Math.floor(Math.random() * letters.length)];
  }
  host += ".com";
  return host;
}
