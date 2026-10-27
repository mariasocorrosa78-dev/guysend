const util = require("util");

function fmt(args) {
  return args.map(a => (typeof a === "string" ? a : util.inspect(a, { depth: 3 }))).join(" ");
}

class Console {
  static log(type, text, color, warp) {
    if (!color || typeof color !== "number") {
      color = 34;
    }
    if (warp) {
      console.log(`\x1b\n[${color}m[${type}]\x1b[0m ` + fmt([text]));
    } else {
      console.log(`\x1b[${color}m[${type}]\x1b[0m ` + fmt([text]));
    }
  }
  static warn(type, ...args) {
    console.log(`\x1b[33m[${type}]\x1b[0m ` + fmt(args));
  }
  static error(type, ...args) {
    console.log(`\x1b[31m[${type}]\x1b[0m ` + fmt(args));
  }
}

module.exports = Console;
