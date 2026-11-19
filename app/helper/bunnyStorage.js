const config = require("config");
const fetch = require("node-fetch");

// Bunny's Storage API, for the storage zone that holds the CDN's Perma-Cache
// (see "Perma-Cache" in config/storage-bucket/README.md). The zone's
// password and region come from the account API with the key the app
// already has for purging (BUNNY_API_SECRET), so no second secret is needed.

const API = "https://api.bunny.net";

let zonePromise = null;

// { name, password, host } of the storage zone named config.bunny.perma_cache_zone
function zone() {
  if (!zonePromise) {
    zonePromise = findZone().catch((err) => {
      zonePromise = null;
      throw err;
    });
  }

  return zonePromise;
}

async function findZone() {
  const name = config.bunny.perma_cache_zone;

  if (!config.bunny.secret || !name)
    throw new Error("bunnyStorage: no Bunny API key or storage zone name");

  const res = await fetch(API + "/storagezone?page=1&perPage=1000", {
    headers: { AccessKey: config.bunny.secret, Accept: "application/json" },
  });

  if (!res.ok)
    throw new Error("bunnyStorage: listing storage zones: HTTP " + res.status);

  const body = await res.json();
  const zones = Array.isArray(body) ? body : body.Items || [];
  const found = zones.find((zone) => zone.Name === name && !zone.Deleted);

  if (!found) throw new Error("bunnyStorage: no storage zone named " + name);

  return {
    name: found.Name,
    password: found.Password,
    host: storageHost(found.Region),
  };
}

// The Storage API's hostname for a zone's main region: Falkenstein ("DE")
// has the plain one, the others a regional prefix
function storageHost(region) {
  if (!region || region === "DE") return "storage.bunnycdn.com";
  return region.toLowerCase() + ".storage.bunnycdn.com";
}

// path is relative to the zone's root, its segments not yet encoded
async function request(method, path) {
  const { name, password, host } = await zone();
  const encoded = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return fetch(`https://${host}/${encodeURIComponent(name)}/${encoded}`, {
    method,
    headers: { AccessKey: password, Accept: "application/json" },
  });
}

// The entries of a directory: [{ name, isDirectory, size, lastChanged,
// dateCreated, checksum }], or [] if it doesn't exist. dir ends with "/" (""
// for the zone's root). checksum is a file's SHA-256, upper-case hex, when
// Bunny has one; the dates are ISO strings in UTC without a zone suffix.
async function list(dir) {
  const res = await request("GET", dir);

  if (res.status === 404) return [];
  if (!res.ok)
    throw new Error("bunnyStorage: listing " + dir + ": HTTP " + res.status);

  const entries = await res.json();

  return entries.map((entry) => ({
    name: entry.ObjectName,
    isDirectory: !!entry.IsDirectory,
    size: entry.Length,
    lastChanged: entry.LastChanged,
    dateCreated: entry.DateCreated,
    checksum: entry.Checksum || null,
  }));
}

// Deletes a file, or a directory and everything in it when path ends with
// "/". Missing is fine.
async function remove(path) {
  const res = await request("DELETE", path);

  if (res.ok || res.status === 404) return;

  throw new Error("bunnyStorage: deleting " + path + ": HTTP " + res.status);
}

module.exports = { list, remove, storageHost };
