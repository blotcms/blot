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

    // Use != null so an explicit 0 bound is respected rather than
    // treated as absent by a truthy check.
    const min =
      range && range[0] != null
        ? range[0]
        : (map[key] && map[key].min) || 1;
    const max =
      range && range[1] != null
        ? range[1]
        : (map[key] && map[key].max) || 60;

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
