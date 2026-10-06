const moment = require("moment");
const fs = require("fs-extra");

require("moment-timezone");

module.exports = async (path, timeZone) => {
        
    const stat = await fs.stat(path);
    const result = {};

    result.modified = moment
      .utc(stat.mtime)
      .tz(timeZone)
      .calendar(null, {
        sameDay: "[Today], h:mm A",
        lastDay: "[Yesterday], h:mm A",
        lastWeek: "LL, h:mm A",
        sameElse: "LL, h:mm A",
      });

      result.updated = moment.utc(stat.mtime).from(moment.utc());
      result.unix = stat.mtime.getTime();
      result.bytes = stat.size;
      result.size = humanFileSize(stat.size);
      result.directory = stat.isDirectory();
      result.file = stat.isFile();
    
    return result;
}

function humanFileSize(size) {
    if (size === 0) return "0 kb";
  
    const i = Math.floor(Math.log(size) / Math.log(1024));
  
    return (
      Math.ceil(size / Math.pow(1024, i)) +
      " " +
      ["bytes", "kB", "MB", "GB", "TB"][i]
    );
  }