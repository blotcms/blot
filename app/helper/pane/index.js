// pane: renders a <pre>-style tree as a mock file-manager window.
// SKELETON: one folder window, three skins (mac, win, linux) switched by
// <html data-os>, light/dark by prefers-color-scheme. See PLAN.md.
//
//   pane.render(text, { title }) -> { html, css, js }
//
// `text` is an indented tree (two spaces per level, folders have children).
// html is one figure per window, css is one shared stylesheet, js is the tiny
// snippet for <head> that sets data-os. The caller ships all three.

const OS_KEYS = ["mac", "win", "linux"];

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function parse(text) {
  const lines = text.split("\n").filter((l) => l.trim());
  return lines.map((line, i) => {
    const depth = (line.length - line.trimStart().length) / 2;
    const next = lines[i + 1];
    const nextDepth = next ? (next.length - next.trimStart().length) / 2 : 0;
    return { name: line.trim(), depth, folder: nextDepth > depth };
  });
}

function render(text, options = {}) {
  const title = options.title || "Folder";
  const rows = parse(text)
    .map(
      (r) =>
        `<li class="pane-row" style="--d:${r.depth}"><i class="pane-icon ${r.folder ? "pane-folder" : "pane-file"}" aria-hidden="true"></i>` +
        `<span>${escape(r.name)}<span class="pane-sr">${r.folder ? ", folder" : ""}</span></span></li>`
    )
    .join("");
  const html =
    `<figure class="pane" aria-label="${escape(title)}">` +
    `<div class="pane-bar" aria-hidden="true"><i class="pane-dots"></i><b>${escape(title)}</b></div>` +
    `<ul class="pane-tree">${rows}</ul></figure>`;
  return { html, css: CSS, js: JS };
}

// Sets data-os unless the page already chose one (the QA harness does).
const JS =
  '(function(d){var e=d.documentElement;if(!e.dataset.os){var u=navigator.userAgent;e.dataset.os=/Android|Windows/.test(u)?"win":/Mac|iPhone|iPad/.test(u)?"mac":/Linux|X11/.test(u)?"linux":"mac"}})(document)';

const CSS = `
.pane{--bg:#fff;--fg:#262626;--dim:#8a8a8a;--bar:#f6f6f6;--line:#d8d8d8;--stripe:#f4f5f5;
margin:0;width:490px;height:360px;box-sizing:border-box;overflow:hidden;background:var(--bg);color:var(--fg);
font:13px/20px -apple-system,"SF Pro Text",system-ui,sans-serif;border-radius:26px;
box-shadow:0 0 0 .5px rgba(0,0,0,.25),0 18px 40px rgba(0,0,0,.35)}
@media (prefers-color-scheme:dark){.pane{--bg:#1e1e1e;--fg:#e8e8e8;--dim:#8e8e8e;--bar:#2a2a2a;--line:#3a3a3a;--stripe:#262626}}
.pane-bar{display:flex;align-items:center;gap:40px;height:52px;padding:0 18px;font-size:15px}
.pane-dots{width:14px;height:14px;border-radius:50%;background:#ff5f57;box-shadow:22px 0 #febc2e,44px 0 #28c840;margin-right:44px}
.pane-tree{list-style:none;margin:28px 0 0;padding:0}
.pane-row{display:flex;align-items:center;height:20px;padding-left:calc(47px + var(--d)*15px)}
.pane-row:nth-child(even){background:var(--stripe)}
.pane-icon{width:12px;height:14px;margin-right:8px;background:#d8d8d8;border-radius:2px}
.pane-folder{background:#5ab4ee}
.pane-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
html[data-os=win] .pane{--bg:#fff;--fg:#1b1b1b;--bar:#eee;font:14px/20px "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
width:504px;height:367px;border-radius:0;box-shadow:none}
html[data-os=win] .pane-bar{background:var(--bar);height:40px;gap:0}
html[data-os=win] .pane-dots{display:none}
html[data-os=win] .pane-tree{margin-top:96px}
html[data-os=win] .pane-row{height:28px;padding-left:calc(30px + var(--d)*16px)}
html[data-os=win] .pane-row:nth-child(even){background:none}
html[data-os=linux] .pane{font:14px/20px Cantarell,"Adwaita Sans",system-ui,sans-serif;width:490px;height:520px;border-radius:12px;box-shadow:none}
html[data-os=linux] .pane-dots{display:none}
html[data-os=linux] .pane-bar{height:48px;gap:0;background:var(--bar)}
html[data-os=linux] .pane-tree{margin-top:32px}
html[data-os=linux] .pane-row{height:52px;padding-left:calc(85px + var(--d)*20px)}
html[data-os=linux] .pane-row:nth-child(even){background:none}
@media (prefers-color-scheme:dark){
html[data-os=win] .pane{--bg:#191919;--fg:#fff;--bar:#202020}
html[data-os=linux] .pane{--bg:#242424;--fg:#fff;--bar:#303030}}
`.replace(/\n(?=[.@}h])/g, "\n");

module.exports = { render, OS_KEYS };
