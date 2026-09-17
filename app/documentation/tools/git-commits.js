const fs = require("fs-extra");
const { join } = require("path");
const moment = require("moment");
const { views_directory } = require("config");

const OUTPUT_PATH = join(views_directory, "git-commits.json");

// Ignores merge commits since they're not useful to readers
// Ignores commits mentioning 'commit' since they're not useful to readers
// Ignores commits to yml test file since there are so many of them
// Ignores commits to todo file since there are so many of them
// Ignores commits with links since they're ugly
const bannedWords = ["merge", "typo", "commit", ".yml", "todo", "://", "dockerfile"];
const bannedWordsRegEx = new RegExp(bannedWords.join("|"), "i");

// Adjust the tense of verbs in commit message
const commitMessageMap = {
  "Adds": "Added",
  "Cleans": "Cleaned",
  "Changes": "Changed",
  "Fixes": "Fixed",
  "Finishes": "Finished",
  "Improves": "Improved",
  "Modifies": "Modified",
  "Removes": "Removed",
  "Tweaks": "Tweaked",
  "Updates to": "Updated",
  "Updates": "Updated"
};

const commitMessageMapRegEx = new RegExp(
  Object.keys(commitMessageMap)
    .sort((a, b) => b.length - a.length) // Sort to match longer keys first
    .map(key => `\\b${key}\\b`) // Add word boundaries
    .join("|"),
  "g"
);

const load = async () => {
  try {
    return await fs.readJSON(OUTPUT_PATH);
  } catch (e) {
    return { recent_commits: [], days: [] };
  }
};

const middleware = async (req, res, next) => {
  try {
    const { recent_commits, days } = await load();

    // Update commit `time` and `fromNow` on each request for accuracy
    const dateFormat = "MMM D, YYYY";
    const today = moment().format(dateFormat);
    const yesterday = moment().subtract(1, "days").format(dateFormat);

    const updatedDays = days.map(dayGroup => {
      // Update each commit within the group
      const updatedCommits = dayGroup.commits.map(commit => {
        commit.time = moment(commit.date).format(dateFormat);

        if (commit.time === today) commit.time = "Today";
        else if (commit.time === yesterday) commit.time = "Yesterday";
        else if (
          moment(commit.date).valueOf() > moment().subtract(6, "days").valueOf()
        )
          commit.time = moment(commit.date).fromNow();

        return commit;
      });

      return { day: updatedCommits[0].time, commits: updatedCommits };
    });

    const updatedRecentCommits = recent_commits.map(commit => ({
      ...commit,
      fromNow: moment(commit.date).fromNow()
    }));

    res.locals.recent_commits = updatedRecentCommits;
    res.locals.days = updatedDays;
    return next();
  } catch (e) {
    console.log("News page: error fetching git commits");
    console.log(e);
    res.locals.recent_commits = [];
    res.locals.days = [];
    return next();
  }
};

const build = async () => {
  try {
    // Fetch the latest commits from the GitHub API
    const response = await fetch(
      "https://api.github.com/repos/blotcms/blot/commits?per_page=300",
      {
        headers: {
          "User-Agent": "GitHub-Commit-Fetcher",
          // Optional: Add your GitHub Personal Access Token if rate limits are an issue
          // Authorization: `Bearer YOUR_PERSONAL_ACCESS_TOKEN`
        }
      }
    );

    if (!response.ok) {
      throw new Error(`GitHub API responded with status ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    
    const commits = [];
    const messageMap = {};

    data.forEach(commitData => {
      const commit = commitData.commit;
      const message = commit.message;
      const author = commit.author?.name || "Unknown";
      const hash = commitData.sha || "Unknown";
      const date = new Date(commit.author?.date || Date.now());

      let formattedMessage = message.split("\n")[0].trim(); // Use only the first line of the commit message

      if (!formattedMessage || bannedWordsRegEx.test(formattedMessage)) return;

      // Adjust tenses in the commit message
      formattedMessage = formattedMessage.replace(commitMessageMapRegEx, matched => {
        return commitMessageMap[matched];
      });

      // Remove references like (#393) or * at the end of commit messages
      if (formattedMessage.indexOf("(#") > -1)
        formattedMessage = formattedMessage.slice(0, formattedMessage.indexOf("(#"));
      if (formattedMessage.indexOf("*") > -1)
        formattedMessage = formattedMessage.slice(0, formattedMessage.indexOf("*"));

      // Prevent duplicate messages
      if (messageMap[formattedMessage]) return;
      messageMap[formattedMessage] = true;

      commits.push({
        author,
        hash,
        date,
        message: formattedMessage
      });
    });

    const days = commits.reduce((groupedDays, commit) => {
      const day = moment(commit.date).format("MMM D, YYYY");
      if (!groupedDays[day]) groupedDays[day] = [];
      groupedDays[day].push(commit);
      return groupedDays;
    }, {});

    const daysArray = Object.entries(days).map(([day, commits]) => ({
      day,
      commits
    }));

    const recent_commits = commits.slice(0, 5);

    await fs.outputJSON(OUTPUT_PATH, { recent_commits, days: daysArray });
  } catch (error) {
    console.error("Error fetching commits from GitHub API:", error);
    throw error;
  }
};

module.exports = { middleware, build };