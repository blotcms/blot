// Thrown by parse-uploaded-template when an upload cannot become a template.
// Carries every problem we found rather than only the first, so the client can
// show the user a complete list instead of one error at a time.
class UploadValidationError extends Error {
  constructor(problems) {
    const count = problems.length;
    super(
      count === 1
        ? "This template could not be uploaded"
        : `This template could not be uploaded (${count} problems)`
    );
    this.name = "UploadValidationError";
    this.status = 422;
    this.problems = problems;
  }
}

module.exports = UploadValidationError;
