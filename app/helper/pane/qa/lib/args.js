// Tiny argument parsing shared by the CLIs.

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) args[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) args[a.slice(2)] = argv[++i];
      else args[a.slice(2)] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function selectCases(cases, args) {
  return cases.filter(
    (c) =>
      (!args.case || args.case === c.id) &&
      (!args.os || args.os === c.os) &&
      (!args.theme || args.theme === c.theme) &&
      (!args.view || args.view === c.view)
  );
}

module.exports = { parseArgs, selectCases };
