var slugify = require("./slugify");
var join = require("path").join;
var moment = require("moment");

module.exports = function (output_directory) {
  return async function (entry) {
    var relative_path_without_extension;
    var slug = slugify(
      entry.slug ||
        entry.title ||
        (entry.dateStamp && entry.dateStamp.toString()) ||
        "untitled"
    );

    var name = slug || entry.name;

    name = name.split("/").join("-");
    name = name.slice(0, 150);

    if (entry.page) {
      relative_path_without_extension = join("Pages", name);
    } else if (entry.draft) {
      relative_path_without_extension = join("Drafts", name);
    } else if (entry.dateStamp) {
      relative_path_without_extension = join(
        moment(entry.dateStamp).format("YYYY"),
        moment(entry.dateStamp).format("MM") +
          "-" +
          moment(entry.dateStamp).format("DD") +
          "-" +
          name
      );
    } else {
      relative_path_without_extension = join("Undated", name);
    }

    entry.path = join(output_directory, relative_path_without_extension);

    return entry;
  };
};
