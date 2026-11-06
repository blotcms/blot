const STATES = [
  {
    key: "syncingSuccessfully",
    label: "Syncing successfully",
    matches: (account) => account.setupComplete === true && !account.error,
  },
  {
    key: "syncingWithErrors",
    label: "Set up, with a stored sync error",
    matches: (account) =>
      account.setupComplete === true && Boolean(account.error),
  },
  {
    key: "setupFailed",
    label: "Failed to set up",
    matches: (account) =>
      account.setupComplete !== true && Boolean(account.error),
  },
  {
    key: "initialTransfer",
    label: "Initial transfer in progress",
    matches: (account) =>
      account.setupComplete !== true &&
      !account.error &&
      account.transferringToiCloud === true,
  },
  {
    key: "waitingForInitialTransfer",
    label: "Folder accepted; initial transfer not started",
    matches: (account) =>
      account.setupComplete !== true &&
      !account.error &&
      account.transferringToiCloud !== true &&
      account.acceptedSharingLink === true,
  },
  {
    key: "waitingForFolderAcceptance",
    label: "Waiting for shared folder acceptance",
    matches: (account) =>
      account.setupComplete !== true &&
      !account.error &&
      account.transferringToiCloud !== true &&
      account.acceptedSharingLink !== true &&
      Boolean(account.sharingLink),
  },
  {
    key: "setupNotStarted",
    label: "Setup not started",
    matches: () => true,
  },
];

const classify = (account) => STATES.find((state) => state.matches(account));

const summarize = (accounts) => {
  const counts = Object.fromEntries(STATES.map(({ key }) => [key, 0]));

  accounts.forEach((account) => {
    counts[classify(account).key]++;
  });

  return { total: accounts.length, counts };
};

const format = ({ total, counts, missingRecords = 0 }) => {
  const countWidth = String(Math.max(total, missingRecords)).length;
  const labelWidth = Math.max(
    42,
    ...STATES.map(({ label }) => label.length),
    "Dangling IDs without account data".length
  );
  const rule = "-".repeat(labelWidth + countWidth + 10);
  const percentage = (count) =>
    total === 0 ? "0.0%" : `${((count / total) * 100).toFixed(1)}%`;
  const lines = [
    "iCloud client statistics",
    "=".repeat(rule.length),
    `${"Total blogs connected".padEnd(labelWidth)} ${String(total).padStart(countWidth)}`,
    rule,
  ];

  STATES.forEach(({ key, label }) => {
    const count = counts[key];
    lines.push(
      `${label.padEnd(labelWidth)} ${String(count).padStart(countWidth)}  ${percentage(
        count
      ).padStart(6)}`
    );
  });

  if (missingRecords > 0) {
    lines.push(rule);
    lines.push(
      `${"Dangling IDs without account data".padEnd(labelWidth)} ${String(
        missingRecords
      ).padStart(countWidth)}`
    );
  }

  return lines.join("\n");
};

module.exports = { STATES, classify, summarize, format };
