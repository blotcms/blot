#!/usr/bin/env node
// Accessibility and mobile audit of the module (see lib/audit.js). Exit 1 when it finds something.
//   node app/helper/pane/qa/a11y.js [--skin mac] [--verbose]
const { launch } = require("./lib/render");
const { audit } = require("./lib/audit");
const { parseArgs } = require("./lib/args");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const browser = await launch(true); // scrollbars shown, as on a real desktop
  try {
    const findings = await audit(browser, { skins: args.skin ? [args.skin] : undefined, log: args.verbose ? console.log : () => {} });
    const unique = new Map();
    for (const f of findings) {
      const key = `${f.skin} ${f.rule} ${f.message}`;
      if (!unique.has(key)) unique.set(key, { ...f, where: [] });
      unique.get(key).where.push(`${f.theme}/${f.sample}@${f.width}`);
    }
    for (const f of unique.values()) console.log(`${f.skin.padEnd(5)} ${f.rule.padEnd(13)} ${f.message}\n      (${f.where.slice(0, 6).join(", ")}${f.where.length > 6 ? `, +${f.where.length - 6}` : ""})`);
    console.log(findings.length ? `\n${unique.size} finding(s)` : "no findings");
    process.exit(findings.length ? 1 : 0);
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
