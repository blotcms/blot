module.exports = (title) => {
  return (
    title
      .trim()
      .slice(0, 150)

      // remove common punction, basically everything except & _ and - /
      // Should we be stripping all &encoded; characters?
      .replace(/%/g, "-percent")
      .replace(/&amp;/g, "and")
      .replace(/&nbsp;/g, " ")
      .replace(/&thinsp;/g, " ")
      .replace(/&mdash;/g, "-")

      .replace(/\.jpg/g, "")
      .replace(/\.jpeg/g, "")
      .replace(/\.png/g, "")
      .replace(/\.gif/g, "")

      .replace(
        /[/«»“”‘–’`~!@#$%^&*()+=\\|\]}{['";:?>.<,]/g,
        ""
      )
      .replace(/-+/g, "-")
  ); // collapse dashes
};
