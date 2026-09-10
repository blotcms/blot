"use strict";

// Nested progress indicator for the scripts/each/* iterators.
//
// Each iterator pushes a frame before its loop and pops it in the loop's
// final callback, ticking once per item:
//
//   var bar = progress.push("Blog", blogIDs.length);
//   ... bar.tick() per blog ...
//   bar.pop();
//
// Because template.js -> blog.js and view.js -> template.js, the frames
// nest on their own and the status line reads
//
//   Blog (23/1500)  Template (1/4)  View (7/12)
//
// On a TTY the line is pinned to the bottom and redrawn after anything the
// script logs, so it survives stdout scrolling past. When stdout is not a
// TTY (CI, a pipe, a log file) it falls back to a throttled plain line so
// the output stays greppable. Set PROGRESS=0 / NO_PROGRESS=1 to silence it;
// it is silent under NODE_ENV=test regardless.

var CLEAR_LINE = "\x1b[2K";
var REDRAW_THROTTLE_MS = 80;
var FALLBACK_THROTTLE_MS = 3000;

var frames = [];

var disabled =
  process.env.PROGRESS === "0" ||
  process.env.NO_PROGRESS === "1" ||
  process.env.NODE_ENV === "test";
var sticky = !disabled && !!process.stdout.isTTY;
var fallback = !disabled && !process.stdout.isTTY;

var realStdoutWrite = null;
var realStderrWrite = null;
var realLog = console.log.bind(console);

var patched = false;
var exitHooked = false;
var lineOnScreen = false;
// True when real output is sitting mid-line (last chunk had no trailing
// newline), so the status line must break to its own line first.
var pendingNewline = false;
var redrawTimer = null;
var lastFallback = 0;

function format() {
  return frames
    .map(function (f) {
      return (
        f.label + " (" + f.index + "/" + (f.total == null ? "?" : f.total) + ")"
      );
    })
    .join("  ");
}

function writeRaw(str) {
  realStdoutWrite.call(process.stdout, str);
}

function eraseLine() {
  if (!lineOnScreen) return;
  writeRaw("\r" + CLEAR_LINE);
  lineOnScreen = false;
}

function drawLine() {
  if (!frames.length) return;
  // Real output is sitting mid-line (a write with no trailing newline).
  // Don't pin the status line over it - wait for the next newline-
  // terminated write, so a logical line emitted as write("foo");
  // write("bar\n") stays "foobar" rather than being split in two.
  if (pendingNewline) return;
  writeRaw(format());
  lineOnScreen = true;
}

function scheduleRedraw() {
  if (!sticky || redrawTimer) return;
  redrawTimer = setTimeout(function () {
    redrawTimer = null;
    eraseLine();
    drawLine();
  }, REDRAW_THROTTLE_MS);
  if (redrawTimer.unref) redrawTimer.unref();
}

function makePatchedWrite(stream, real) {
  return function (chunk) {
    eraseLine();
    var ret = real.apply(stream, arguments);
    var str = typeof chunk === "string" ? chunk : String(chunk);
    if (str.length) pendingNewline = str.charAt(str.length - 1) !== "\n";
    drawLine();
    return ret;
  };
}

function install() {
  if (!sticky || patched) return;
  patched = true;
  realStdoutWrite = process.stdout.write;
  realStderrWrite = process.stderr.write;
  process.stdout.write = makePatchedWrite(process.stdout, realStdoutWrite);
  process.stderr.write = makePatchedWrite(process.stderr, realStderrWrite);
  if (!exitHooked) {
    exitHooked = true;
    process.on("exit", teardown);
  }
}

function teardown() {
  if (!patched) return;
  eraseLine();
  process.stdout.write = realStdoutWrite;
  process.stderr.write = realStderrWrite;
  patched = false;
}

function maybeFallbackLog(force) {
  if (!fallback || !frames.length) return;
  var now = Date.now();
  if (!force && now - lastFallback < FALLBACK_THROTTLE_MS) return;
  lastFallback = now;
  realLog("progress: " + format());
}

function onChange(force) {
  if (sticky) scheduleRedraw();
  else if (fallback) maybeFallbackLog(force);
}

// push(label[, total]) -> handle. total may be null/undefined when unknown;
// call handle.setTotal(n) later once it is known.
function push(label, total) {
  var frame = { label: label, index: 0, total: total == null ? null : total };
  frames.push(frame);
  install();
  // Show the 0/N state right away, so a slow or hanging first item still
  // renders an indicator before it calls tick().
  onChange(false);

  var handle = {
    tick: function (n) {
      frame.index += n || 1;
      onChange(false);
      return handle;
    },
    setIndex: function (n) {
      frame.index = n;
      onChange(false);
      return handle;
    },
    setTotal: function (n) {
      frame.total = n;
      onChange(false);
      return handle;
    },
    pop: function () {
      var i = frames.indexOf(frame);
      if (i === -1) return handle;

      // When the outermost frame finishes, emit one final line so a
      // completed run's last record reads N/N - even when the whole run
      // fit inside the fallback throttle window. Inner frames stay
      // throttled: a long run pops one frame per view.
      var outermost = frames.length === 1;
      var finalLine = outermost ? format() : null;

      frames.splice(i, 1);

      if (outermost) {
        if (fallback && finalLine) realLog("progress: " + finalLine);
        if (sticky && redrawTimer) {
          clearTimeout(redrawTimer);
          redrawTimer = null;
        }
        teardown();
      } else {
        // Time-throttled in fallback mode: a long run pops a frame per
        // view, which must not mean a log line per view.
        onChange(false);
      }

      return handle;
    },
  };

  return handle;
}

module.exports = { push: push };
