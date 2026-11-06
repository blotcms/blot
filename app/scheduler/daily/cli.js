module.exports = function (main) {
  main().then(
    function (result) {
      console.log(result);
      process.exit();
    },
    function (err) {
      console.error(err);
      process.exit(1);
    }
  );
};
