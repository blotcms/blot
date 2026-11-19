import Bottleneck from "bottleneck";

// Setup and leaveFolder both drive Finder's windows and dialogs, so only one of
// them may run at a time, or one would click the other's dialog.
export default new Bottleneck({ maxConcurrent: 1 });
