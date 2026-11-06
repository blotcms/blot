const fs = require("fs");
const path = require("path");
const vm = require("vm");

function extractNamedFunction(source, functionName) {
  const signature = `function ${functionName}(`;
  const start = source.indexOf(signature);

  if (start === -1) {
    throw new Error(`Could not find ${functionName} in template`);
  }

  const braceStart = source.indexOf("{", start);

  let depth = 0;
  let end = braceStart;

  for (; end < source.length; end += 1) {
    const char = source[end];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

function extractEventListenerHandler(source, targetExpression, eventName) {
  const signature = `${targetExpression}.addEventListener('${eventName}', function (event) `;
  const start = source.indexOf(signature);

  if (start === -1) {
    throw new Error(
      `Could not find ${targetExpression} ${eventName} listener in template`
    );
  }

  const functionStart = source.indexOf("function (event)", start);
  const braceStart = source.indexOf("{", functionStart);

  let depth = 0;
  let end = braceStart;

  for (; end < source.length; end += 1) {
    const char = source[end];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(functionStart, end);
}

function createModalEvent(action) {
  const button = {
    disabled: false,
    getAttribute: (name) => (name === "data-upload-action" ? action : null),
  };

  return {
    target: {
      closest: (selector) => {
        if (selector === "[data-upload-modal-close]") return null;
        if (selector === "[data-upload-action]") return button;
        return null;
      },
    },
  };
}

function createModalActionButtons(actions) {
  return actions.map((action) => ({
    disabled: false,
    getAttribute: (name) => (name === "data-upload-action" ? action : null),
  }));
}

describe("folder directory upload modal listener lifecycle", function () {
  it("does not keep stale action listeners across upload attempts after partial failure", async function () {
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    const templatePath = path.join(
      __dirname,
      "../../views/dashboard/folder/directory.html"
    );
    const templateSource = fs.readFileSync(templatePath, "utf8");
    const uploadDroppedFilesSource = extractNamedFunction(
      templateSource,
      "uploadDroppedFiles"
    );

    const clickListeners = new Set();
    const uploadModal = {
      hidden: false,
      addEventListener: (event, handler) => {
        if (event === "click") clickListeners.add(handler);
      },
      removeEventListener: (event, handler) => {
        if (event === "click") clickListeners.delete(handler);
      },
    };

    let commitCount = 0;

    const context = {
      Promise,
      fetch: () =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ overwrite: ["existing.txt"] }),
        }),
      buildUploadFormData: () => ({}),
      applyCurrentFolderPrefix: (relativePath) => relativePath,
      renderUploadPreview: () => {},
      openUploadModal: () => {
        uploadModal.hidden = false;
      },
      closeUploadModal: () => {
        uploadModal.hidden = true;
      },
      uploadModal,
      commitUpload: () => {
        commitCount += 1;
        // Simulate partial-failure UX where modal remains visible.
        uploadModal.hidden = false;
        return Promise.resolve();
      },
      "{{{base}}}": "",
    };

    vm.runInNewContext(
      `${uploadDroppedFilesSource}\nthis.uploadDroppedFiles = uploadDroppedFiles;`,
      context
    );

    const collectedFiles = [
      { file: { name: "example.txt" }, relativePath: "example.txt" },
    ];

    const firstAttempt = context.uploadDroppedFiles(collectedFiles);
    await flush();
    clickListeners.forEach((handler) => handler(createModalEvent("upload")));
    await firstAttempt;

    expect(commitCount).toBe(1);
    expect(clickListeners.size).toBe(0);

    const secondAttempt = context.uploadDroppedFiles(collectedFiles);
    await flush();
    clickListeners.forEach((handler) => handler(createModalEvent("upload")));
    await secondAttempt;

    expect(commitCount).toBe(2);
    expect(clickListeners.size).toBe(0);
  });

  it("allows only one submit across rapid multi-clicks on different action buttons", async function () {
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    const templatePath = path.join(
      __dirname,
      "../../views/dashboard/folder/directory.html"
    );
    const templateSource = fs.readFileSync(templatePath, "utf8");
    const uploadDroppedFilesSource = extractNamedFunction(
      templateSource,
      "uploadDroppedFiles"
    );

    const clickListeners = new Set();
    const modalActionButtons = createModalActionButtons(["cancel", "upload"]);
    const uploadModal = {
      hidden: false,
      querySelectorAll: (selector) => {
        if (selector === "[data-upload-action]") return modalActionButtons;
        return [];
      },
      addEventListener: (event, handler) => {
        if (event === "click") clickListeners.add(handler);
      },
      removeEventListener: (event, handler) => {
        if (event === "click") clickListeners.delete(handler);
      },
    };

    let commitCount = 0;
    let resolveCommit;

    const context = {
      Promise,
      fetch: () =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ overwrite: ["existing.txt"] }),
        }),
      buildUploadFormData: () => ({}),
      applyCurrentFolderPrefix: (relativePath) => relativePath,
      renderUploadPreview: () => {},
      openUploadModal: () => {
        uploadModal.hidden = false;
      },
      closeUploadModal: () => {
        uploadModal.hidden = true;
      },
      uploadModal,
      commitUpload: () => {
        commitCount += 1;
        return new Promise((resolve) => {
          resolveCommit = resolve;
        });
      },
      "{{{base}}}": "",
    };

    vm.runInNewContext(
      `${uploadDroppedFilesSource}\nthis.uploadDroppedFiles = uploadDroppedFiles;`,
      context
    );

    const collectedFiles = [
      { file: { name: "example.txt" }, relativePath: "example.txt" },
    ];
    const firstAttempt = context.uploadDroppedFiles(collectedFiles);

    await flush();

    Array.from(clickListeners).forEach((handler) =>
      handler(createModalEvent("cancel"))
    );

    expect(commitCount).toBe(0);
    await firstAttempt;

    const secondAttempt = context.uploadDroppedFiles(collectedFiles);
    await flush();

    Array.from(clickListeners).forEach((handler) =>
      handler(createModalEvent("upload"))
    );
    Array.from(clickListeners).forEach((handler) =>
      handler(createModalEvent("upload"))
    );

    expect(commitCount).toBe(1);
    modalActionButtons.forEach((button) => {
      expect(button.disabled).toBe(true);
    });

    resolveCommit();
    await secondAttempt;

    modalActionButtons.forEach((button) => {
      expect(button.disabled).toBe(false);
    });
  });
});

describe("folder directory upload modal visibility state", function () {
  it("is hidden by default and toggles hidden state through open/close handlers", function () {
    const templatePath = path.join(
      __dirname,
      "../../views/dashboard/folder/directory.html"
    );
    const templateSource = fs.readFileSync(templatePath, "utf8");
    const openUploadModalSource = extractNamedFunction(
      templateSource,
      "openUploadModal"
    );
    const closeUploadModalSource = extractNamedFunction(
      templateSource,
      "closeUploadModal"
    );

    const uploadModal = { hidden: true };
    const bodyClasses = new Set();

    const context = {
      uploadModal,
      document: {
        body: {
          classList: {
            add: (className) => bodyClasses.add(className),
            remove: (className) => bodyClasses.delete(className),
          },
        },
      },
    };

    vm.runInNewContext(
      `${openUploadModalSource}
${closeUploadModalSource}
this.openUploadModal = openUploadModal;
this.closeUploadModal = closeUploadModal;`,
      context
    );

    expect(uploadModal.hidden).toBe(true);

    context.openUploadModal();
    expect(uploadModal.hidden).toBe(false);
    expect(bodyClasses.has("upload-modal-open")).toBe(true);

    context.closeUploadModal();
    expect(uploadModal.hidden).toBe(true);
    expect(bodyClasses.has("upload-modal-open")).toBe(false);
  });
});

describe("folder directory global drop and folder highlight behavior", function () {
  it("uses helper-driven drop handling: window drops upload and folder drops only clear highlight", async function () {
    const templatePath = path.join(
      __dirname,
      "../../views/dashboard/folder/directory.html"
    );
    const templateSource = fs.readFileSync(templatePath, "utf8");
    const hasFileDragPayloadSource = extractNamedFunction(
      templateSource,
      "hasFileDragPayload"
    );
    const isFileDropEventSource = extractNamedFunction(
      templateSource,
      "isFileDropEvent"
    );
    const showDropTargetSource = extractNamedFunction(
      templateSource,
      "showDropTarget"
    );
    const hideDropTargetSource = extractNamedFunction(
      templateSource,
      "hideDropTarget"
    );
    const resetDropStateSource = extractNamedFunction(
      templateSource,
      "resetDropState"
    );
    const windowDropHandlerSource = extractEventListenerHandler(
      templateSource,
      "window",
      "drop"
    );
    const folderDropHandlerSource = extractEventListenerHandler(
      templateSource,
      "folderBox",
      "drop"
    );

    const calls = {
      collect: 0,
      upload: 0,
    };

    const context = {
      Promise,
      dragDepth: 2,
      dropTarget: { style: { display: "flex" } },
      collectDroppedFiles: () => {
        calls.collect += 1;
        return Promise.resolve([
          { file: { name: "a.txt" }, relativePath: "a.txt" },
        ]);
      },
      uploadDroppedFiles: (entries) => {
        calls.upload += 1;
        return Promise.resolve(entries);
      },
      console: { error: () => {} },
    };

    vm.runInNewContext(
      `${hasFileDragPayloadSource}
${isFileDropEventSource}
${showDropTargetSource}
${hideDropTargetSource}
${resetDropStateSource}
this.windowDropHandler = ${windowDropHandlerSource};
this.folderDropHandler = ${folderDropHandlerSource};`,
      context
    );

    const createEvent = (dataTransfer) => ({
      dataTransfer,
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    });

    const outsideFolderDrop = createEvent({
      items: [{ kind: "file" }],
      types: ["Files"],
      files: [{ name: "a.txt" }],
    });

    context.windowDropHandler(outsideFolderDrop);
    await Promise.resolve();
    await Promise.resolve();

    expect(outsideFolderDrop.prevented).toBe(true);
    expect(calls.collect).toBe(1);
    expect(calls.upload).toBe(1);
    expect(context.dragDepth).toBe(0);
    expect(context.dropTarget.style.display).toBe("none");

    context.dragDepth = 3;
    context.dropTarget.style.display = "flex";

    const folderDrop = createEvent({
      items: [{ kind: "file" }],
      types: ["Files"],
      files: [{ name: "b.txt" }],
    });

    context.folderDropHandler(folderDrop);
    expect(folderDrop.prevented).toBe(true);
    expect(context.dragDepth).toBe(0);
    expect(context.dropTarget.style.display).toBe("none");
    expect(calls.collect).toBe(1);
    expect(calls.upload).toBe(1);
  });

  it("keeps helper behavior file-specific for highlight and upload triggers", async function () {
    const templatePath = path.join(
      __dirname,
      "../../views/dashboard/folder/directory.html"
    );
    const templateSource = fs.readFileSync(templatePath, "utf8");
    const hasFileDragPayloadSource = extractNamedFunction(
      templateSource,
      "hasFileDragPayload"
    );
    const isFileDropEventSource = extractNamedFunction(
      templateSource,
      "isFileDropEvent"
    );
    const showDropTargetSource = extractNamedFunction(
      templateSource,
      "showDropTarget"
    );
    const hideDropTargetSource = extractNamedFunction(
      templateSource,
      "hideDropTarget"
    );
    const resetDropStateSource = extractNamedFunction(
      templateSource,
      "resetDropState"
    );
    const folderDragEnterHandlerSource = extractEventListenerHandler(
      templateSource,
      "folderBox",
      "dragenter"
    );
    const windowDropHandlerSource = extractEventListenerHandler(
      templateSource,
      "window",
      "drop"
    );

    const context = {
      Promise,
      dragDepth: 0,
      dropTarget: { style: { display: "none" } },
      collectDroppedFiles: () => Promise.resolve([]),
      uploadDroppedFiles: () => Promise.resolve(),
      console: { error: () => {} },
    };

    vm.runInNewContext(
      `${hasFileDragPayloadSource}
${isFileDropEventSource}
${showDropTargetSource}
${hideDropTargetSource}
${resetDropStateSource}
this.folderDragEnterHandler = ${folderDragEnterHandlerSource};
this.windowDropHandler = ${windowDropHandlerSource};`,
      context
    );

    const dragEnterEvent = {
      dataTransfer: {
        items: [{ kind: "string" }],
        types: ["text/plain"],
        files: [],
      },
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };

    context.folderDragEnterHandler(dragEnterEvent);

    expect(dragEnterEvent.prevented).toBe(false);
    expect(context.dragDepth).toBe(0);
    expect(context.dropTarget.style.display).toBe("none");

    let collectCalled = false;
    context.collectDroppedFiles = () => {
      collectCalled = true;
      return Promise.resolve([]);
    };

    const nonFileDrop = {
      dataTransfer: {
        items: [{ kind: "string" }],
        types: ["text/plain"],
        files: [],
      },
      preventDefault() {},
    };

    context.windowDropHandler(nonFileDrop);
    await Promise.resolve();

    expect(collectCalled).toBe(false);
  });
});

describe("folder directory upload path prefixing", function () {
  it("prefixes upload relative paths when browsing a subfolder", function () {
    const templatePath = path.join(
      __dirname,
      "../../views/dashboard/folder/directory.html"
    );
    const templateSource = fs.readFileSync(templatePath, "utf8");
    const normalizeCurrentFolderPrefixSource = extractNamedFunction(
      templateSource,
      "normalizeCurrentFolderPrefix"
    );
    const applyCurrentFolderPrefixSource = extractNamedFunction(
      templateSource,
      "applyCurrentFolderPrefix"
    );
    const buildUploadFormDataSource = extractNamedFunction(
      templateSource,
      "buildUploadFormData"
    );

    const appended = [];

    function MockFormData() {
      this.append = function (key, value) {
        appended.push({ key, value });
      };
    }

    const context = {
      FormData: MockFormData,
      csrfToken: "token",
      currentFolderPrefix: "posts/drafts/",
    };

    vm.runInNewContext(
      `${normalizeCurrentFolderPrefixSource}
${applyCurrentFolderPrefixSource}
${buildUploadFormDataSource}
this.buildUploadFormData = buildUploadFormData;`,
      context
    );

    context.buildUploadFormData(
      [
        { file: { name: "index.md" }, relativePath: "index.md" },
        { file: { name: "nested.md" }, relativePath: "nested/nested.md" },
      ],
      { dryRun: true }
    );

    const relativePathsEntry = appended.find(
      (entry) => entry.key === "relativePaths"
    );
    const relativePaths = JSON.parse(relativePathsEntry.value);

    expect(relativePaths).toEqual([
      { field: "upload-0", index: 0, relativePath: "posts/drafts/index.md" },
      {
        field: "upload-1",
        index: 0,
        relativePath: "posts/drafts/nested/nested.md",
      },
    ]);
  });
});
