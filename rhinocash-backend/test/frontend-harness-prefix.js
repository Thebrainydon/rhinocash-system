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
}
const __elements = {};
global.document = {
  getElementById(id){ if(!__elements[id]) __elements[id] = new FakeEl(); return __elements[id]; },
  createElement(){ return new FakeEl(); },
};
global.window = { RHINOCASH_API_BASE: process.env.BACKEND_URL || 'http://localhost:4000', scrollTo(){} };
global.alert = (msg) => { console.log('  [alert]', msg.split('\n')[0]); };
global.confirm = () => true; // headless harness has no user to click OK — assume confirm for scripted flows that reach it
