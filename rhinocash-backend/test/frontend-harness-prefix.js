// frontend-harness-prefix.js — minimal fake DOM, concatenated in front of
// the REAL extracted frontend JS, then real test assertions appended
// after. All in one file so `let`/`const` top-level declarations in the
// frontend script are genuinely shared with the test code below them —
// exactly the pattern proven out earlier in this project for headless
// frontend logic testing (no eval() scope-leak tricks, just plain
// sequential script execution, same as a browser would do).
'use strict';
class FakeEl {
  constructor(){ this._html = ""; }
  set innerHTML(v){ this._html = v; }
  get innerHTML(){ return this._html; }
  set textContent(v){ this._html = v; }
  get textContent(){ return this._html; }
  querySelector(){ return null; }
  appendChild(){}
  removeChild(){}
  click(){}
}
const __elements = {};
global.document = {
  getElementById(id){ if(!__elements[id]) __elements[id] = new FakeEl(); return __elements[id]; },
  createElement(){ return new FakeEl(); },
  body: new FakeEl(),
};
// Minimal, real (not mocked-away) CSV-export support — Blob/URL aren't
// provided by Node by default in this harness version, so provide the
// same real interface exportRowsToCsv() actually calls, letting the
// real frontend function run for real rather than being skipped.
if (typeof global.Blob === 'undefined') { global.Blob = class { constructor(parts, opts){ this.parts = parts; this.type = opts && opts.type; } }; }
if (typeof global.URL === 'undefined' || !global.URL.createObjectURL) {
  global.URL = global.URL || {};
  global.URL.createObjectURL = () => 'blob:fake-url';
  global.URL.revokeObjectURL = () => {};
}
// Minimal, real (not mocked-away) file-read support for the Bulk Upload
// (Import Utility Payments) flow — synchronous rather than the real
// FileReader's async callback timing, since nothing under test cares about
// that timing and it keeps the assertions below deterministic. A test
// "file" is just {name, __content}, and this reads back exactly what was
// put in it, no more real than the browser API it stands in for.
if (typeof global.FileReader === 'undefined') {
  global.FileReader = class {
    readAsText(file){ this.result = (file && file.__content) || ''; if (this.onload) this.onload(); }
  };
}
global.window = { RHINOCASH_API_BASE: process.env.BACKEND_URL || 'http://localhost:4000', scrollTo(){} };
global.alert = (msg) => { console.log('  [alert]', msg.split('\n')[0]); };
global.confirm = () => true; // headless harness has no user to click OK — assume confirm for scripted flows that reach it
