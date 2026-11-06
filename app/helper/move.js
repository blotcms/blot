const fs = require("fs-extra");
const { join, dirname, basename, extname } = require("path");

// A function which will try to move a file or directory
// if the destination alread exists, it will add a suffix
// to the destination file name to prevent a conflict.
// e.g. if you 'move' 'a.txt' to a location with another 'a.txt'
// then 'move' will rename it 'a copy.txt'.
const move = async (base, from, to, suffix = "", name = "", extension = "") => {
  try {
    await fs.move(join(base, from), join(base, to));
  } catch (e) {
    if (e && e.message === "dest already exists.") {
      const { suffix, destination, name, extension } = suffixer(to);
      return move(base, from, destination, suffix, name, extension);
    } else {
      console.log("Error: Move:", e);
      console.log("  from:", from);
      console.log("  to:", to);
      throw e;
    }
  }

  return { destination: to, suffix, name, extension };
};

const suffixer = (path) => {
  const dir = dirname(path);
  const extension = extname(path);

  let suffix;
  let numberAtEnd;
  let nameWithoutNumber;

  let name = basename(path, extension);

  try {
    numberAtEnd = parseInt(name.split(" ").pop());
    if (isNaN(numberAtEnd)) {
      numberAtEnd = null;
    } else {
      nameWithoutNumber = name.split(" ").slice(0, -1).join(" ");
    }
  } catch (e) {}

  // 'a copy.txt' => 'a copy 2.txt'
  if (name.endsWith(" copy")) {
    suffix = " copy 2";
    name = name.slice(0, -" copy".length);
    // 'a copy 2.txt' => 'a copy 3.txt'
  } else if (numberAtEnd && nameWithoutNumber.endsWith(" copy")) {
    suffix = ` copy ${numberAtEnd + 1}`;
    name = nameWithoutNumber.slice(0, -" copy".length);
    // 'a.txt' => 'a copy.txt'
  } else {
    suffix = " copy";
  }

  const destination = join(dir, `${name}${suffix}${extension}`);
  return { destination, suffix, name, extension };
};

// export for testing purposes
move.suffixer = suffixer;

module.exports = move;
