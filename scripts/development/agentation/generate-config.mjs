import { copyFile, mkdir, writeFile } from "node:fs/promises";

// The proxy's include hooks (proxy/config/development.conf): maps at http
// level, locations in each public server, response rewriting in each proxied
// location. node-app mounts generated/openresty at /etc/openresty/development.
const host = process.env.BLOT_HOST || "local.blot";
if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host)) {
  throw new Error("BLOT_HOST must be a lowercase local hostname without a scheme or port");
}
const escapedHost = host.replaceAll(".", "\\.");
const generated = new URL("generated/openresty/", import.meta.url);

for (const level of ["http", "server", "proxy"]) {
  await mkdir(new URL(`${level}/`, generated), { recursive: true });
}

await writeFile(new URL("http/agentation.conf", generated), `
map $host $agentation_enabled {
    default 0;
    ~^cdn\\. 0;
    ~^(?:[a-z0-9-]+\\.)*${escapedHost}$ 1;
    ~^(?:[a-z0-9-]+\\.)*[a-e]-${escapedHost}$ 1;
}
map $agentation_enabled $agentation_script {
    default '';
    1 '<script defer src="/__agentation/toolbar.js" data-blot-agentation="local"></script>';
}
`);
await copyFile(new URL("openresty/server.conf", import.meta.url), new URL("server/agentation.conf", generated));
await copyFile(new URL("openresty/proxy.conf", import.meta.url), new URL("proxy/agentation.conf", generated));
