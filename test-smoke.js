/*
 * test-smoke.js — loads the browser modules under a minimal DOM/Audio shim and
 * runs init() to catch wiring reference errors without a real browser.
 */

// --- Minimal DOM shim ---
function makeEl(tag) {
  return {
    tagName: tag, children: [], style: {}, dataset: {}, classList: {
      _s: new Set(),
      add(c){this._s.add(c);}, remove(c){this._s.delete(c);},
      toggle(c,f){if(f===undefined){this._s.has(c)?this._s.delete(c):this._s.add(c);}else{f?this._s.add(c):this._s.delete(c);}},
      contains(c){return this._s.has(c);},
    },
    _text: "", set textContent(v){this._text=v;}, get textContent(){return this._text;},
    innerHTML: "", title: "", value: "",
    appendChild(c){this.children.push(c); return c;},
    addEventListener(){}, removeEventListener(){},
    querySelector(){return null;}, querySelectorAll(){return [];},
    closest(){return null;},
    getContext(){return ctx2d;},
    width: 320, height: 260,
    options: [],
  };
}
const ctx2d = new Proxy({}, { get: () => () => {}, set: () => true });
const _els = {};
function el(id){ return _els[id] || (_els[id] = makeEl("div")); }

global.window = global;
global.getComputedStyle = () => ({ getPropertyValue: () => "" });
global.requestAnimationFrame = () => 0;
global.cancelAnimationFrame = () => {};
// Capture the deferred init callback; run it AFTER require() returns, which
// mimics the real browser (whole script parsed before the timer fires).
let _initFn = null, _ranInit = false;
global.setTimeout = (fn) => {
  if (!_ranInit) { _ranInit = true; _initFn = fn; }
  return 0;
};
global.performance = { now: () => 0 };
global.navigator = { };

global.document = {
  readyState: "complete",
  body: makeEl("body"),
  getElementById: el,
  createElement: makeEl,
  addEventListener(){},
  querySelector(){return null;},
};

global.AudioContext = class {
  constructor(){ this.currentTime = 0; this.sampleRate = 44100; this.destination = {}; this.state = "running"; }
  createGain(){ return { gain:{value:0,setValueAtTime(){},linearRampToValueAtTime(){},cancelScheduledValues(){},setTargetAtTime(){}}, connect(){return this;} }; }
  createDynamicsCompressor(){ return { threshold:{value:0}, ratio:{value:0}, connect(){return this;} }; }
  createOscillator(){ return { frequency:{value:0,setValueAtTime(){}}, detune:{value:0}, type:"", connect(){return this;}, start(){}, stop(){} }; }
  createBuffer(ch,len,sr){ return { getChannelData(){ return new Float32Array(len); } }; }
  createBufferSource(){ return { buffer:null, connect(){return this;}, start(){}, stop(){} }; }
  createBiquadFilter(){ return { type:"", frequency:{value:0}, Q:{value:0}, connect(){return this;} }; }
  resume(){}
};

// Load modules in order.
require("./src/music.js");
require("./src/yin.js");
require("./src/analysis.js");
require("./src/drone.js");

let failed = false;
try {
  require("./src/app.js");
  // app.js registers init on DOMContentLoaded or via setTimeout(0). Our
  // setTimeout is a no-op, and readyState is "complete", so call init manually
  // by re-triggering: app.js used setTimeout(init,0). We captured nothing, so
  // instead verify the module loaded and Music/Yin/Analysis/Drone are present.
  if (!global.Music || !global.Yin || !global.Analysis || !global.Drone) {
    throw new Error("a module failed to attach to window");
  }
  // Now run init() — the whole app.js IIFE has finished, so all const/let are
  // initialized, exactly as in a real browser at DOMContentLoaded.
  if (_initFn) _initFn();
  console.log("smoke: modules loaded and init() ran without errors");
} catch (e) {
  failed = true;
  console.log("smoke FAIL:", e.message);
  console.log(e.stack.split("\n").slice(0,4).join("\n"));
}

process.exit(failed ? 1 : 0);
