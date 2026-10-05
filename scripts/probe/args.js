// Argument parsing shared by the probe wrappers (run locally) and the probe
// scripts (run in the container). Each option is declared up front, so a
// boolean flag never swallows the argument after it: `--heap-snapshot
// https://x/archives` is a flag and a URL, not a flag with a value.
//
//   spec: { name: { value: "N", help: "..." } }  takes a value (--name N or --name=N)
//         { name: { help: "..." } }              boolean
//
// Returns { options, rest }: `rest` keeps every positional argument and, with
// { strict: false }, every undeclared option, in order - so a wrapper can
// take its own options and pass the rest through to the probe untouched.

function parseArgs(argv, spec, { strict = true } = {}) {
  const options = {};
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const match = /^--([^=]+)(?:=(.*))?$/s.exec(arg);

    if (!match || !Object.prototype.hasOwnProperty.call(spec, match[1])) {
      if (match && strict) throw new Error(`Unknown option ${arg}`);
      rest.push(arg);
      continue;
    }

    const [, key, inline] = match;
    if (!spec[key].value) {
      if (inline !== undefined) throw new Error(`--${key} doesn't take a value`);
      options[key] = true;
      continue;
    }

    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined) throw new Error(`--${key} needs a value (${spec[key].value})`);
    options[key] = value;
  }

  return { options, rest };
}

// One line per option, for --help.
function describe(spec) {
  return Object.entries(spec)
    .filter(([, option]) => option.help)
    .map(([name, option]) => {
      const flag = `--${name}` + (option.value ? ` ${option.value}` : "");
      return `  ${flag.padEnd(22)}${option.help}`;
    })
    .join("\n");
}

module.exports = { parseArgs, describe };
