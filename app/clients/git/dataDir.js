const config = require("config");
const { data_directory } = config;
const { join } = require("path");
const git_data_directory = join(data_directory, "git");
const fs = require("fs-extra");

fs.ensureDirSync(git_data_directory);

// consolidated reference to location of bareRepoDirectory in
// tests and code so we can move this in future painlessly:
// basically look for '/data'
module.exports = git_data_directory;
