import { readFile, mkdir, writeFile } from "node:fs/promises";

const root = new URL("../../../", import.meta.url);
const host = process.env.BLOT_HOST || "local.blot";
if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host)) {
  throw new Error("BLOT_HOST must be a lowercase local hostname without a scheme or port");
}
const escapedHost = host.replaceAll(".", "\\.");
const source = await readFile(new URL("scripts/development/proxy/development_server.conf", root), "utf8");
// Derive from the current development proxy, retaining CDN and worktree routing.
// Fail clearly if its structure changes, instead of silently losing injection.
if (!source.includes("http {") || !source.includes("ssl_certificate_key ") || !source.includes("proxy_pass http://blot_node;")) {
  throw new Error("Development nginx config changed; update Agentation generation");
}
const config = source
  .replace("http {", "http {\n    include /etc/nginx/agentation-hosts.conf;")
  .replace(/(ssl_certificate_key [^;]+;)/g, "$1\n        include /etc/nginx/agentation/server.conf;")
  .replace(/(proxy_pass http:\/\/(?:blot_node|\$preview_upstream:8080);)/g,
    "include /etc/nginx/agentation/proxy.conf;\n            $1");

await mkdir(new URL("generated/", import.meta.url), { recursive: true });
await writeFile(new URL("generated/nginx.conf", import.meta.url), config);
await writeFile(new URL("generated/hosts.conf", import.meta.url), `
map $host $agentation_enabled {
    default 0;
    ~^cdn\\. 0;
    ~^(?:[a-z0-9-]+\\.)*${escapedHost}$ 1;
    ~^(?:[a-z0-9-]+\\.)*[a-e]-local\\.blot$ 1;
}
map $agentation_enabled $agentation_script {
    default '';
    1 '<script defer src="/__agentation/toolbar.js" data-blot-agentation="local"></script>';
}
`);
