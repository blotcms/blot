#!/usr/bin/env node

const getQuestion = require("models/question/get");

function printUsage() {
  console.error("Usage: node scripts/questions/author.js <question-id or URL>");
}

function extractId(rawInput) {
  if (!rawInput) return null;

  const trimmed = rawInput.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  let candidate = trimmed;
  let parsedUrl = null;

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate);
  if (!hasScheme) {
    try {
      parsedUrl = new URL("https://" + candidate.replace(/^\/+/, ""));
    } catch (err) {
      parsedUrl = null;
    }
  }

  if (!parsedUrl) {
    try {
      parsedUrl = new URL(candidate);
    } catch (err) {
      parsedUrl = null;
    }
  }

  if (parsedUrl) {
    const match = parsedUrl.pathname.match(/\/questions\/(\d+)(?:\b|\/|$)/);
    if (match) {
      return match[1];
    }
  }

  const fallbackMatch = candidate.match(/questions\/(\d+)/);
  if (fallbackMatch) {
    return fallbackMatch[1];
  }

  return null;
}

async function main() {
  const input = process.argv[2];

  if (!input) {
    printUsage();
    process.exit(1);
  }

  const id = extractId(input);

  if (!id || !/^\d+$/.test(id)) {
    console.error("Error: Unable to determine numeric question ID from input.");
    printUsage();
    process.exit(1);
  }

  try {
    const question = await getQuestion(id);

    if (!question) {
      console.error(`Error: Question with ID ${id} was not found.`);
      process.exit(1);
    }

    if (question.author === undefined || question.author === null) {
      console.log("");
    } else {
      console.log(question.author);
    }

    process.exit(0);
  } catch (error) {
    console.error(
      "Error fetching question:",
      error && error.message ? error.message : error
    );
    process.exit(1);
  }
}

main();
