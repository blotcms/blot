const desnake = require("./desnake");

module.exports = (key, locals, map) => {
  const label =
    map && map[key] && map[key].label ? map[key].label : desnake(key);

  if (typeof locals[key] === "boolean") {
    return {
      key,
      label,
      value: locals[key],
      isBoolean: true
    };
  }

  if (locals[key + "_range"] !== undefined || key === "page_size") {
    const range = locals[key + "_range"];
    const mapEntry = map && map[key];

    // Use != null so a legitimate zero bound is preserved rather than
    // falling through to the defaults (e.g. a spacing range of [0, 3]).
    const min =
      range && range[0] != null
        ? range[0]
        : mapEntry && mapEntry.min != null
        ? mapEntry.min
        : 1;
    const max =
      range && range[1] != null
        ? range[1]
        : mapEntry && mapEntry.max != null
        ? mapEntry.max
        : 60;

    return {
      key,
      label,
      value: locals[key],
      isRange: true,
      min,
      max
    };
  }

  if (
    locals[key + "_options"] !== undefined &&
    locals[key + "_options"].constructor === Array
  ) {
    const options = locals[key + "_options"].map(option => {
      return {
        label: desnake(option),
        selected: locals[key] === option ? "selected" : "",
        value: option
      };
    });

    return {
      key,
      label,
      value: locals[key],
      isSelect: true,
      options
    };
  }
};
