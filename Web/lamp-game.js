// Lamp's game runtime for a game drawn with three.js, or with Phaser for a 2D game (lamp-phaser.js, which runs Phaser's
// scenes through this). Lamp writes this file before every build; don't edit it.
//
// The game is two functions, init and frame, given to game(): the runtime runs them about 60 times a second wherever
// the game is played (on the Mac and on an iPhone or iPad in Lamp's app around the page, on the Xbox in its web host),
// draws at 1920x1080 scaled to the screen (smaller when frames run slow there), and hands each frame the controllers
// as pads: a controller connected to the device, the keyboard as the first pad, and on a touch screen the touch
// controls it draws. Lamp's preview runs the same
// page out of sight from a script of the controller's moves, at exactly 1/60 s a frame with the same random numbers
// every play, so use frame.dt, random() and save()/load() from here, never requestAnimationFrame, Math.random, the
// clock or localStorage yourself. What the player is holding (a controller, and whose, the keyboard or the touch screen)
// is input(), and label() and glyph() name and draw a button for it, so a prompt never names one the player hasn't got.
//
//   import * as THREE from 'three';
//   import { game, BUTTON, STICK, random, sound, log, label, glyph, onInput, fixedStep } from './lamp-game.js';
//   const renderer = new THREE.WebGLRenderer({ antialias: true });
//   game({ renderer, async init() { … }, frame(f) { … renderer.render(scene, camera); } });

import device from './lamp-device.js';
import controllers from './lamp-controllers.js';

export const WIDTH = 1920, HEIGHT = 1080;

// The controller's buttons, as bits of a pad's down, pressed and released.
export const BUTTON = { A: 1, B: 2, X: 4, Y: 8, LB: 16, RB: 32, MENU: 64, VIEW: 128, UP: 256, DOWN: 512, LEFT: 1024, RIGHT: 2048,
                        LSTICK: 4096, RSTICK: 8192 };
// The sticks and triggers, for `label` and `glyph` (a pad reads them as lx, ly, rx, ry, lt and rt).
export const STICK = { LEFT: 'stick-left', RIGHT: 'stick-right' };
export const TRIGGER = { LT: 'lt', RT: 'rt' };

const preview = window.lampPreview || null;   // set by Lamp's preview before the page runs
const logs = [];
// The browser's own functions, kept before the runtime starts watching what the game's code leaves running (see
// "Running the game's code again"): the runtime's own listeners, timers and sound go through these, so they stay when
// the game's are taken away.
// A runtime run outside a page (Lamp's tests) may have none of them, and uses whatever the target has.
const events = globalThis.EventTarget && EventTarget.prototype;
const browser = {
    listen: events ? events.addEventListener : function (...rest) { return this.addEventListener(...rest); },
    unlisten: events ? events.removeEventListener : function (...rest) { return this.removeEventListener(...rest); },
    setTimeout: window.setTimeout, clearTimeout: window.clearTimeout, setInterval: window.setInterval, clearInterval: window.clearInterval,
    frame: window.requestAnimationFrame, cancelFrame: window.cancelAnimationFrame,
    AudioContext: window.AudioContext || window.webkitAudioContext, Worker: window.Worker,
};
const listen = (target, ...rest) => browser.listen.call(target, ...rest);
const after = (ms, fn) => browser.setTimeout.call(window, fn, ms);
const nextFrame = fn => browser.frame.call(window, fn);

// MARK: Random numbers, the same each preview play (xorshift64*, as the C++ kit has it)

let seed = preview ? 1n : BigInt(Date.now()) | 1n;
const mask = (1n << 64n) - 1n;
// How many have been drawn, so a part that's kept rather than built again can skip the draws its build made.
let draws = 0;
export function random() {
    draws++;
    seed ^= seed >> 12n; seed ^= (seed << 25n) & mask; seed ^= seed >> 27n;
    return Number(((seed * 0x2545F4914F6CDD1Dn) & mask) >> 40n) / 16777216;
}
let clock = 0;
if (preview) {
    // three.js and the game's own code may reach for these: in the preview they're the game's clock and seed too.
    Math.random = random;
    performance.now = () => clock;
    Date.now = () => 1700000000000 + clock;
    window.__lampAdvance = ms => { clock += ms; };
}

// MARK: The log, saves and files

export function log(...parts) {
    const line = parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ');
    const said = `[${time.toFixed(2)} s] ${line}`;
    if (preview) { if (logs.length < 400) logs.push(said); return; }
    // The app around the page puts its console into the app's log.
    console.log(said);
}
window.addEventListener('error', e => log(`Error: ${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
window.addEventListener('unhandledrejection', e => log(`Error: ${e.reason && e.reason.message || e.reason}`));

const saved = preview ? new Map() : null;
export function save(name, value) {
    const text = JSON.stringify(value);
    if (saved) saved.set(name, text); else try { localStorage.setItem('lamp.save.' + name, text); } catch (e) { return false; }
    return true;
}
export function load(name) {
    const text = saved ? saved.get(name) : (() => { try { return localStorage.getItem('lamp.save.' + name); } catch (e) { return null; } })();
    try { return text == null ? null : JSON.parse(text); } catch (e) { return null; }
}

// A file beside the page (assets/ship.glb), as bytes. Loaded through here (or texture(), model() and sound.load()),
// a file Lamp changes while the game is played can be put into it without starting again (see "Changes while it's
// played" below).
export async function asset(path) {
    took(clean(path));
    const answer = await fetch(fresh(path));
    if (!answer.ok) { log(`asset: no ${path}`); return null; }
    return answer.arrayBuffer();
}

// The files the game loaded through the runtime, and how the runtime puts a new copy of each in by itself.
const loaded = new Set(), swaps = new Map();
const clean = path => String(path).replace(/^\.?\//, '').split(/[?#]/)[0];
// Asked again after a change, a file is asked for by a new address, so nothing on the way keeps the old one.
let changes = 0;
const fresh = path => changes ? `${path}${String(path).includes('?') ? '&' : '?'}lamp=${changes}` : path;

// A picture beside the page as a three.js texture, set up by `setup(texture)` (its color space, wrapping, repeat…). A
// new copy of the picture goes into the same texture while the game is played, so every material using it shows it.
export async function texture(path, setup) {
    const THREE = await import('three');
    const loader = new THREE.TextureLoader();
    const made = await loader.loadAsync(fresh(path));
    if (setup) setup(made);
    took(clean(path));
    swaps.set(clean(path), [...(swaps.get(clean(path)) || []), async () => {
        const again = await loader.loadAsync(fresh(path));
        made.image = again.image;
        made.needsUpdate = true;
        again.dispose();
    }]);
    return made;
}

// A glTF model beside the page (.glb or .gltf), as a THREE.Group holding its scene, with its animations in
// `group.animations`. A new copy of the file replaces what's inside the group while the game is played, where the group
// is: a copy made with clone(), and a mixer playing its animations, are the game's to make again in assetChanged.
export async function model(path) {
    const THREE = await import('three');
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    const group = new THREE.Group();
    const fill = gltf => { group.clear(); group.add(gltf.scene); group.animations = gltf.animations; };
    fill(await loader.loadAsync(fresh(path)));
    group.name = clean(path);
    took(clean(path));
    swaps.set(clean(path), [...(swaps.get(clean(path)) || []), async () => {
        const old = [...group.children];
        fill(await loader.loadAsync(fresh(path)));
        for (const child of old) child.traverse(o => { o.geometry && o.geometry.dispose(); });
    }]);
    return group;
}

// MARK: Sound, mixed by the browser's Web Audio; the preview plays nothing and says what was played

const sounds = [];
let audio = null, effectsVolume = 1, musicVolume = 1, musicVoice = null, music = { gain: 0 };
const played = new Map();
// The effects playing now, so a change of the effects volume reaches them too.
const voices = new Set();
function context() {
    if (preview) return null;
    if (!audio) { try { audio = new browser.AudioContext({ sampleRate: 48000 }); } catch (e) { return null; } }
    if (audio.state === 'suspended') audio.resume();
    return audio;
}
// Played as soon as the page is touched, clicked or a key pressed, for a browser that holds sound back until then.
for (const kind of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(kind, () => context(), { passive: true });

function made(samples, name) {
    const s = { id: sounds.length + 1, name, samples, buffer: null };
    sounds.push(s);
    return s;
}
function bufferOf(s) {
    const ctx = context();
    if (!ctx || !s || !s.samples) return null;
    if (!s.buffer) {
        s.buffer = ctx.createBuffer(1, s.samples.length, 48000);
        s.buffer.copyToChannel(s.samples, 0);
    }
    return s.buffer;
}

export const sound = {
    // An effect made in code: a wave ('sine', 'square', 'triangle', 'saw', 'noise') from one pitch to another under a
    // simple envelope, in seconds.
    tone({ wave = 'square', from = 440, to = from, attack = 0.005, hold = 0.08, release = 0.1, volume = 0.6, name } = {}) {
        const n = Math.max(1, Math.round((attack + hold + release) * 48000));
        const out = new Float32Array(n);
        let phase = 0, noise = 0x2545F491;
        for (let i = 0; i < n; i++) {
            const t = i / 48000, at = t / Math.max(1e-6, attack + hold + release);
            const hz = from + (to - from) * at;
            phase = (phase + hz / 48000) % 1;
            let v;
            if (wave === 'sine') v = Math.sin(phase * 2 * Math.PI);
            else if (wave === 'triangle') v = 1 - 4 * Math.abs(phase - 0.5);
            else if (wave === 'saw') v = 2 * phase - 1;
            else if (wave === 'noise') { noise ^= noise << 13; noise ^= noise >>> 17; noise ^= noise << 5; v = ((noise >>> 0) / 4294967296) * 2 - 1; }
            else v = phase < 0.5 ? 1 : -1;
            const env = t < attack ? t / attack : t < attack + hold ? 1 : Math.max(0, 1 - (t - attack - hold) / Math.max(1e-6, release));
            out[i] = v * env * volume * 0.5;
        }
        return made(out, name || `${wave} ${Math.round(from)}→${Math.round(to)} Hz`);
    },
    // An effect from samples worked out in code: mono, -1 to 1, at `rate` a second.
    samples(values, rate = 48000, name = 'samples') {
        const n = Math.round(values.length * 48000 / rate), out = new Float32Array(n);
        for (let i = 0; i < n; i++) out[i] = values[Math.min(values.length - 1, Math.floor(i * rate / 48000))] || 0;
        return made(out, name);
    },
    // A sound file beside the page (.wav, .ogg, .mp3, .m4a), decoded whole: load each in init, never per frame.
    async load(path) {
        const s = made(null, path);
        // A new copy of the file is decoded into the same sound, so what plays it next plays the new one.
        const decode = async () => {
            const ctx = context();
            if (!ctx) return;
            try { s.buffer = await ctx.decodeAudioData(await (await fetch(fresh(path))).arrayBuffer()); } catch (e) { log(`sound: couldn't load ${path}`); }
        };
        took(clean(path));
        swaps.set(clean(path), [...(swaps.get(clean(path)) || []), decode]);
        await decode();
        return s;
    },
    // Plays an effect, and gives the voice playing it (null when it didn't): volume 0 to 1, pan -1 to 1, pitch 1 as
    // made (2 an octave up). loop plays it over and over until stopped.
    play(s, { volume = 1, pan = 0, pitch = 1, loop = false } = {}) {
        if (!s) return null;
        played.set(s.name, (played.get(s.name) || 0) + 1);
        const ctx = context(), buffer = bufferOf(s) || s.buffer;
        if (!ctx || !buffer) return null;
        const source = ctx.createBufferSource(), gain = ctx.createGain(), panner = ctx.createStereoPanner();
        source.buffer = buffer; source.loop = loop; source.playbackRate.value = pitch;
        gain.gain.value = volume * effectsVolume; panner.pan.value = pan;
        source.connect(gain).connect(panner).connect(ctx.destination);
        source.start();
        const voice = { source, gain, panner, volume };
        voices.add(voice);
        source.onended = () => voices.delete(voice);
        return voice;
    },
    set(voice, { volume, pan, pitch } = {}) {
        if (!voice) return;
        if (volume != null) { voice.volume = volume; voice.gain.gain.value = volume * effectsVolume; }
        if (pan != null) voice.panner.pan.value = pan;
        if (pitch != null) voice.source.playbackRate.value = pitch;
    },
    stop(voice) { try { voice && voice.source.stop(); } catch (e) {} },
    // Music: a sound played over and over under the effects (keep it quiet, 0.3 to 0.5); null fades it out.
    music(s, volume = 0.4) {
        const ctx = context();
        if (s) played.set('music: ' + s.name, 1);
        if (musicVoice && ctx) { const old = musicVoice; old.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.3); after(1500, () => sound.stop(old)); }
        musicVoice = null;
        music.gain = volume;
        if (!s || !ctx) return;
        const buffer = bufferOf(s) || s.buffer;
        if (!buffer) return;
        const source = ctx.createBufferSource(), gain = ctx.createGain(), panner = ctx.createStereoPanner();
        source.buffer = buffer; source.loop = true;
        gain.gain.value = 0;
        gain.gain.setTargetAtTime(volume * musicVolume, ctx.currentTime, 0.3);
        source.connect(gain).connect(panner).connect(ctx.destination);
        source.start();
        musicVoice = { source, gain, panner };
    },
    // The person's own volumes for effects and for music, 0 to 1: what the game's settings change, kept with save().
    volume(effects, musicLevel) {
        effectsVolume = effects; musicVolume = musicLevel;
        for (const voice of voices) voice.gain.gain.value = voice.volume * effectsVolume;
        if (musicVoice) musicVoice.gain.gain.value = music.gain * musicVolume;
    },
};

// MARK: The controllers

const keys = new Set();
// Only the keyboard's own keys: the Xbox's lamp.js sends the controller as key events too (which aren't trusted, being
// made by a script), and the controller is read whole through the Gamepad API.
// A Samsung or LG TV's remote names its keys only by number: its arrows are the keyboard's, OK is Enter, Back is Escape.
const REMOTE = { 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 13: 'Enter', 10009: 'Escape', 461: 'Escape' };
const codeOf = e => e.code || REMOTE[e.keyCode] || '';
window.addEventListener('keydown', e => { if (!e.isTrusted) return; const code = codeOf(e); keys.add(code); if (code.startsWith('Arrow') || code === 'Space' || code === 'Tab') e.preventDefault(); });
window.addEventListener('keyup', e => { if (e.isTrusted) keys.delete(codeOf(e)); });
window.addEventListener('blur', () => keys.clear());

// The keyboard as a pad: the keys for each button and for each way a stick or trigger goes, the first the one a
// prompt names (`label`).
const KEYS = { [BUTTON.A]: ['Space', 'Enter'], [BUTTON.B]: ['Escape', 'Backspace'], [BUTTON.X]: ['KeyF'], [BUTTON.Y]: ['KeyR'],
               [BUTTON.LB]: ['KeyQ'], [BUTTON.RB]: ['KeyE'], [BUTTON.MENU]: ['KeyP'], [BUTTON.VIEW]: ['Tab'],
               [BUTTON.UP]: ['ArrowUp'], [BUTTON.DOWN]: ['ArrowDown'], [BUTTON.LEFT]: ['ArrowLeft'], [BUTTON.RIGHT]: ['ArrowRight'] };
const STICK_KEYS = { left: { up: ['KeyW', 'ArrowUp'], left: ['KeyA', 'ArrowLeft'], down: ['KeyS', 'ArrowDown'], right: ['KeyD', 'ArrowRight'] },
                     right: { up: ['KeyI'], left: ['KeyJ'], down: ['KeyK'], right: ['KeyL'] } };
const TRIGGER_KEYS = { lt: ['KeyZ'], rt: ['KeyC'] };

function keyboardPad() {
    const any = codes => codes.some(c => keys.has(c)), axis = (plus, minus) => (any(plus) ? 1 : 0) - (any(minus) ? 1 : 0);
    const l = STICK_KEYS.left, r = STICK_KEYS.right;
    const pad = { lx: axis(l.right, l.left), ly: axis(l.up, l.down), rx: axis(r.right, r.left), ry: axis(r.up, r.down),
                  lt: any(TRIGGER_KEYS.lt) ? 1 : 0, rt: any(TRIGGER_KEYS.rt) ? 1 : 0, down: 0 };
    for (const bit in KEYS) if (any(KEYS[bit])) pad.down |= Number(bit);
    return pad;
}

const dead = v => Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85;
function gamepadPad(g) {
    const b = i => g.buttons[i] && g.buttons[i].pressed;
    const pad = { connected: true, lx: dead(g.axes[0] || 0), ly: -dead(g.axes[1] || 0), rx: dead(g.axes[2] || 0), ry: -dead(g.axes[3] || 0),
                  lt: g.buttons[6] ? g.buttons[6].value : 0, rt: g.buttons[7] ? g.buttons[7].value : 0, down: 0 };
    const bits = [BUTTON.A, BUTTON.B, BUTTON.X, BUTTON.Y, BUTTON.LB, BUTTON.RB, 0, 0, BUTTON.VIEW, BUTTON.MENU, BUTTON.LSTICK, BUTTON.RSTICK,
                  BUTTON.UP, BUTTON.DOWN, BUTTON.LEFT, BUTTON.RIGHT];
    bits.forEach((bit, i) => { if (bit && b(i)) pad.down |= bit; });
    pad.gamepad = g;
    return pad;
}

// The first controller as an app around the page reads it itself (Lamp's Android app, whose WebView doesn't promise
// the Gamepad API): sticks -1 to 1 with up positive, triggers 0 to 1, buttons as BUTTON bits.
// `vendor` is the controller's USB vendor, which an app from before it was sent leaves out.
let nativePad = null;
// All at rest is no controller in hand (one that went away sends that), so the touch controls can come back.
window.lampNativePad = (lx, ly, rx, ry, lt, rt, down, vendor) => {
    nativePad = down || lx || ly || rx || ry || lt || rt ? { connected: true, lx, ly, rx, ry, lt, rt, down, vendor } : null;
};

function merge(pad, more) {
    pad.down |= more.down;
    for (const axis of ['lx', 'ly', 'rx', 'ry', 'lt', 'rt']) if (Math.abs(more[axis]) > Math.abs(pad[axis])) pad[axis] = more[axis];
}

// The controller's rumble, 0 to 1 for its two motors, for `seconds` (a short shake by default).
export function rumble(pad, low, high, seconds = 0.2) {
    const g = (pads[pad] || {}).gamepad;
    if (preview) { if (low || high) log(`rumble: controller ${pad + 1} ${low.toFixed(2)} ${high.toFixed(2)}`); return; }
    g && g.vibrationActuator && g.vibrationActuator.playEffect('dual-rumble', { duration: seconds * 1000, strongMagnitude: low, weakMagnitude: high }).catch(() => {});
}

// MARK: Touch controls, on a touch screen while no controller is connected, or once the screen is touched

let touchButtons = BUTTON.A | BUTTON.B | BUTTON.MENU;
// A page with touch controls of its own, or one that reads the keyboard itself, turns Lamp's off (`game`).
let drawsTouch = true, readsKeyboard = true;
const touch = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, down: 0 };
// A tap shorter than a frame still reaches the game: held for the next frame it reads.
let tapped = 0;
let touchShown = false, touchLayer = null;
const touchScreen = !preview && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

function buildTouch() {
    touchLayer = document.createElement('div');
    touchLayer.style.cssText = 'position:fixed;inset:0;z-index:10;touch-action:none;user-select:none;-webkit-user-select:none;font:700 22px -apple-system,system-ui,sans-serif;color:#fff';
    const stick = (side, axes) => {
        const zone = document.createElement('div');
        zone.style.cssText = `position:absolute;top:0;bottom:0;${side}:0;width:50%`;
        const ring = document.createElement('div'), knob = document.createElement('div');
        ring.style.cssText = 'position:absolute;width:120px;height:120px;margin:-60px 0 0 -60px;border-radius:50%;background:rgba(255,255,255,.18);display:none';
        knob.style.cssText = 'position:absolute;width:54px;height:54px;margin:-27px 0 0 -27px;border-radius:50%;background:rgba(255,255,255,.45);display:none';
        zone.append(ring, knob);
        // Where the left stick is, before a thumb is on it.
        const rest = document.createElement('div');
        if (side === 'left') {
            rest.style.cssText = 'position:absolute;left:calc(40px + env(safe-area-inset-left));bottom:calc(32px + env(safe-area-inset-bottom));width:120px;height:120px;border-radius:50%;border:2px solid rgba(255,255,255,.25)';
            zone.append(rest);
        }
        let id = null, sx = 0, sy = 0;
        listen(zone, 'pointerdown', e => { id = e.pointerId; sx = e.clientX; sy = e.clientY; zone.setPointerCapture(id); move(e); });
        const move = e => {
            if (e.pointerId !== id) return;
            let dx = e.clientX - sx, dy = e.clientY - sy;
            const length = Math.hypot(dx, dy), scale = Math.min(1, 60 / Math.max(1, length));
            dx *= scale; dy *= scale;
            touch[axes[0]] = dx / 60; touch[axes[1]] = -dy / 60;
            const r = zone.getBoundingClientRect();
            ring.style.left = (sx - r.left) + 'px'; ring.style.top = (sy - r.top) + 'px';
            knob.style.left = (sx - r.left + dx) + 'px'; knob.style.top = (sy - r.top + dy) + 'px';
            ring.style.display = knob.style.display = 'block';
            rest.style.display = 'none';
        };
        listen(zone, 'pointermove', move);
        const end = e => {
            if (e.pointerId !== id) return;
            id = null; touch[axes[0]] = touch[axes[1]] = 0;
            ring.style.display = knob.style.display = 'none';
            rest.style.display = '';
        };
        listen(zone, 'pointerup', end); listen(zone, 'pointercancel', end);
        return zone;
    };
    touchLayer.append(stick('left', ['lx', 'ly']));
    if (touchButtons & BUTTON.RSTICK) touchLayer.append(stick('right', ['rx', 'ry']));
    const button = (bit, title, css, small) => {
        if (!(touchButtons & bit)) return;
        const size = small ? 44 : 64;
        const b = document.createElement('div');
        b.textContent = title;
        b.style.cssText = `position:absolute;${css};width:${size}px;height:${size}px;line-height:${size}px;text-align:center;border-radius:50%;background:rgba(255,255,255,.22);font-size:${small ? 15 : 22}px`;
        const on = e => { e.stopPropagation(); touch.down |= bit; tapped |= bit; b.style.background = 'rgba(255,255,255,.5)'; b.setPointerCapture(e.pointerId); };
        const off = () => { touch.down &= ~bit; b.style.background = 'rgba(255,255,255,.22)'; };
        listen(b, 'pointerdown', on); listen(b, 'pointerup', off); listen(b, 'pointercancel', off);
        touchLayer.append(b);
    };
    // Kept clear of a phone's rounded corners and its camera (the safe area).
    const at = (x, side, y, edge) => `${side}:calc(${x}px + env(safe-area-inset-${side}));${edge}:calc(${y}px + env(safe-area-inset-${edge}))`;
    const face = bit => TOUCH_FACES[bit] || BASE.names[nameOf(bit)];
    button(BUTTON.A, face(BUTTON.A), at(110, 'right', 40, 'bottom'));
    button(BUTTON.B, face(BUTTON.B), at(40, 'right', 110, 'bottom'));
    button(BUTTON.X, face(BUTTON.X), at(180, 'right', 110, 'bottom'));
    button(BUTTON.Y, face(BUTTON.Y), at(110, 'right', 180, 'bottom'));
    button(BUTTON.LB, face(BUTTON.LB), at(30, 'left', 20, 'top'), true);
    button(BUTTON.VIEW, face(BUTTON.VIEW), at(90, 'left', 20, 'top'), true);
    button(BUTTON.MENU, face(BUTTON.MENU), at(90, 'right', 20, 'top'), true);
    button(BUTTON.RB, face(BUTTON.RB), at(30, 'right', 20, 'top'), true);
    document.body.append(touchLayer);
}
if (touchScreen) window.addEventListener('pointerdown', () => { if (!touchShown) { touchShown = true; showTouch(); } }, { capture: true });
function showTouch() { if (!drawsTouch) return; if (!touchLayer) buildTouch(); touchLayer.style.display = 'block'; touchShown = true; }
function hideTouch() { if (touchLayer) touchLayer.style.display = 'none'; touchShown = false; }

// MARK: What the player plays with, and what to call its buttons

// The page never works out which device it's on. Lamp writes it beside this file in every copy of the page
// (lamp-device.js, from the device's row in Lamp's table of devices): what its keyboard calls the keys keyboards name
// differently, the controller that comes with it, and the one layout every controller there has, where the device
// has one. The controllers a game names buttons for, and how each is told apart, are Lamp's list (lamp-controllers.js).
const LAYOUTS = Object.fromEntries(controllers.layouts.map(layout => [layout.id, layout]));
const BASE = LAYOUTS[controllers.base];

// The input the player used last: a controller (and whose), the keyboard (with the mouse) or the touch screen. A
// device that comes with a controller starts on it, a touch screen on touch, anything else and Lamp's preview on the
// keyboard (the controller named by the device's one layout where it has one, as every controller there is); it
// changes as soon as the player presses a key, touches the screen or moves a controller.
let current = preview ? { kind: 'keyboard' } : device.controller ? { kind: 'controller', family: device.layout || device.controller }
    : touchScreen ? { kind: 'touch' } : { kind: 'keyboard' };
// The controller's own name, for a model that marks a button differently from the rest of its layout (a DualShock's
// Share where a DualSense has Create).
let padName = '';
const variantOf = (family, name) => ((LAYOUTS[family] || {}).variants || []).find(v => new RegExp(v.match, 'i').test(name)) || null;
const listeners = new Set();

export function input() { return Object.assign({}, current); }
// Calls `changed(input())` now and again each time the player takes up another input, to draw the prompts and help
// for it; returns a function that stops it.
export function onInput(changed) {
    listeners.add(changed);
    try { changed(input()); } catch (e) { log(`Error: ${e.message}`); }
    return () => listeners.delete(changed);
}

function use(kind, family, name = '') {
    if (preview) return;
    // A new controller of the same family can still change a label (a DualShock's Share where a DualSense has Create).
    const relabels = variantOf(family, name) !== variantOf(family, padName);
    padName = name;
    if (current.kind === kind && current.family === family && !relabels) return;
    current = family ? { kind, family } : { kind };
    log(`Lamp: playing with ${family ? (LAYOUTS[family] || {}).spoken || controllers.unknown : 'the ' + kind}.`);
    for (const changed of listeners) try { changed(input()); } catch (e) { log(`Error: ${e.message}`); }
}

// Whose controller it is: the device's one layout where it has one, or else what the controller reports, its name as
// the browser gives it (with its USB vendor in Chrome's) or the vendor an app around the page sends with the pad. One
// from an app that doesn't send a vendor is taken as the base layout.
function familyOf(id) {
    if (device.layout) return device.layout;
    const found = controllers.layouts.find(layout => new RegExp(layout.match, 'i').test(id));
    return found ? found.id : 'other';
}
function vendorFamily(vendor) {
    if (device.layout) return device.layout;
    if (!vendor) return controllers.base;
    const found = controllers.layouts.find(layout => layout.vendors.includes(vendor));
    return found ? found.id : 'other';
}

if (!preview) {
    window.addEventListener('keydown', e => { if (e.isTrusted) use('keyboard'); }, { capture: true });
    window.addEventListener('pointerdown', e => {
        if (e.pointerType === 'touch' || e.pointerType === 'pen') use('touch'); else if (e.pointerType === 'mouse') use('keyboard');
    }, { capture: true, passive: true });
}

// What a prompt names each part of the pad by is the layout's (a part it leaves out is the base layout's): BUTTON.A
// is a place, the bottom face button, so a prompt names what's printed on the button in that place on the player's
// controller. The touch controls name their word buttons as these do.
const TOUCH_NAMES = { MENU: 'Menu', VIEW: 'View' };
// What the touch controls draw on a button whose name is a word.
const TOUCH_FACES = { [BUTTON.MENU]: '≡', [BUTTON.VIEW]: '⧉' };
const nameOf = what => typeof what === 'number' ? Object.keys(BUTTON).find(name => BUTTON[name] === what)
    : ({ [STICK.LEFT]: 'STICK_L', [STICK.RIGHT]: 'STICK_R', [TRIGGER.LT]: 'LT', [TRIGGER.RT]: 'RT' })[what];

// A key's name as it's printed on the key, from its code (KeyboardEvent.code): the device's own name for it, or a PC
// keyboard's.
function keyName(code) {
    const named = { Space: 'Space', Enter: 'Enter', Escape: 'Esc', Backspace: 'Backspace', Tab: 'Tab',
                    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ShiftLeft: 'Shift', ShiftRight: 'Shift',
                    ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt',
                    MetaLeft: 'Win', MetaRight: 'Win', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/' };
    return (device.keys || {})[code] || named[code] || (/^(Key|Digit|Numpad)(.+)$/.exec(code) || [])[2] || code;
}

function keysFor(name) {
    if (name === 'STICK_L' || name === 'STICK_R') {
        const s = STICK_KEYS[name === 'STICK_L' ? 'left' : 'right'];
        return [s.up[0], s.left[0], s.down[0], s.right[0]];
    }
    if (name === 'LT' || name === 'RT') return [TRIGGER_KEYS[name.toLowerCase()][0]];
    const codes = KEYS[BUTTON[name]];
    return codes ? [codes[0]] : null;
}

// What to call a button (BUTTON.A…), a stick (STICK.LEFT) or a trigger (TRIGGER.RT) on the input the player is using
// (or the one given): "A", "✕", "Space", "W A S D". A key's code ('KeyH'), for a page that reads keys itself, is that
// key's name whatever the input. null when the input has nothing for it (no key for a stick's click, no touch button
// the game didn't ask for), so the prompt is left out.
export function label(what, on = current) {
    const name = nameOf(what);
    if (!name) return typeof what === 'string' ? keyName(what) : null;
    if (on.kind === 'keyboard') { const codes = readsKeyboard ? keysFor(name) : null; return codes ? codes.map(keyName).join(' ') : null; }
    if (on.kind === 'touch') {
        if (!drawsTouch) return null;
        if (name === 'STICK_L') return BASE.names.STICK_L;
        if (name === 'STICK_R') return touchButtons & BUTTON.RSTICK ? BASE.names.STICK_R : null;
        const bit = BUTTON[name];
        return bit && bit < BUTTON.UP && (touchButtons & bit) ? TOUCH_NAMES[name] || BASE.names[name] : null;
    }
    const variant = variantOf(on.family, padName);
    return (variant && variant.names[name]) || ((LAYOUTS[on.family] || {}).names || {})[name] || BASE.names[name];
}

// A badge for a button, stick or trigger as the player's input draws it (an Xbox controller's colored round letters,
// a PlayStation controller's shapes, a key's keycap), sized to the text around it: a <span> to put in a prompt or
// a help screen, or null where `label` is.
export function glyph(what, on = current) {
    const text = label(what, on);
    if (text == null) return null;
    const name = nameOf(what), el = document.createElement('span');
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', text);
    el.style.cssText = 'display:inline-flex;gap:.18em;vertical-align:middle;line-height:1;white-space:nowrap';
    const badge = (content, css) => {
        const b = document.createElement('span');
        b.textContent = content;
        b.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:1.7em;min-width:1.7em;'
            + 'padding:0 .4em;font:700 .8em/1 -apple-system,system-ui,"Segoe UI",sans-serif;letter-spacing:0;' + css;
        el.append(b);
    };
    if (on.kind === 'keyboard' || !name) {
        // A key: a light keycap with its lower edge, one for each key a stick takes.
        for (const key of text.split(' ')) badge(key, 'border-radius:.35em;background:linear-gradient(#fdfdfe,#e3e4e8);color:#1d1d22;'
            + 'border:1px solid #a9abb3;border-bottom-width:.2em;box-shadow:0 1px 2px rgba(0,0,0,.35)' + (key.length > 1 ? ';padding:0 .55em' : ''));
        return el;
    }
    const dark = 'background:#18191d;color:#fff;border:.12em solid rgba(255,255,255,.28);box-shadow:0 1px 3px rgba(0,0,0,.45);';
    if (on.kind === 'touch') {
        const face = TOUCH_FACES[BUTTON[name]] || text;
        badge(name.startsWith('STICK') ? '' : face, 'border-radius:50%;background:rgba(255,255,255,.22);color:#fff;'
            + (name.startsWith('STICK') ? 'border:.12em solid rgba(255,255,255,.45)' : 'border:0'));
        return el;
    }
    const layout = LAYOUTS[on.family] || {};
    if (['A', 'B', 'X', 'Y'].includes(name)) {
        const colour = (layout.faces || {})[name] || '#fff';
        badge(text, dark + `border-radius:50%;padding:0;color:${colour};` + (layout.faceSize ? `font-size:${layout.faceSize}` : ''));
    } else if (name.startsWith('STICK')) {
        // A stick: a ring with its side's letter in it.
        badge(name === 'STICK_L' ? 'L' : 'R', dark + 'border-radius:50%;padding:0;box-shadow:inset 0 0 0 .2em #18191d,inset 0 0 0 .3em rgba(255,255,255,.35)');
    } else if (['UP', 'DOWN', 'LEFT', 'RIGHT'].includes(name)) {
        badge(({ UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→' })[name], dark + 'border-radius:.3em;padding:0');
    } else if (name === 'LT' || name === 'RT') {
        badge(text, dark + 'border-radius:.75em .75em .3em .3em');
    } else if (name === 'LB' || name === 'RB') {
        badge(text, dark + 'border-radius:.3em .3em .6em .6em');
    } else if ((layout.menuGlyphs || {})[name]) {
        badge(layout.menuGlyphs[name], dark + 'border-radius:50%;padding:0');
    } else {
        // Menu and View by their words (Options, Create, + and −), and a stick's click.
        badge(text, dark + 'border-radius:.85em;' + (text.length > 2 ? 'font-size:.62em;text-transform:uppercase;letter-spacing:.04em' : ''));
    }
    return el;
}

// MARK: A fixed step, for physics

// Physics (Rapier's world.step(), or the game's own) wants the same step every time, whatever the device's frame rate:
// a step that follows the frame bounces and tunnels differently at 30, 60 and 120 frames a second, and the preview's
// replay only matches the play when the steps do. fixedStep(step) gives a function to call once a frame with f.dt: it
// runs step() as many times as the time since the last frame holds, at 1/60 s each (`rate` a second), and at most `most`
// times, so a device that can't keep up slows the game down rather than falling further behind. It returns how far the
// frame is into the next step, 0 to 1, for a game that places what it draws between the last two steps (most needn't).
// In the preview every frame is exactly one step.
//
//   const physics = fixedStep(() => world.step(events));
//   frame(f) { steer(f.pads[0]); physics(f.dt); place(); renderer.render(scene, camera); }
export function fixedStep(step, { rate = 60, most = 4 } = {}) {
    const h = 1 / rate;
    let owed = 0;
    return dt => {
        owed += dt;
        let n = 0;
        // A hair under a whole step still counts as one, so a frame of 1/60 s is always one step of 1/60 s.
        while (owed >= h - 1e-9 && n < most) { step(h); owed -= h; n++; }
        if (n === most) owed = Math.min(owed, h);
        return Math.max(0, owed) / h;
    };
}

// MARK: The frame

let time = 0, number = 0;
const pads = [0, 1, 2, 3].map(() => ({ connected: false, lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, down: 0, pressed: 0, released: 0 }));
let renderer = null, frameFunction = null, scripted = null, before = [0, 0, 0, 0], seenControllers = -1;

// Whether a controller is being played with now: a button down or a stick off its center.
const inUse = g => g.buttons.some(b => b && b.pressed) || g.axes.some(a => Math.abs(a) > 0.3);

function readPads() {
    const found = scripted ? [] : Array.from(navigator.getGamepads ? navigator.getGamepads() : []).filter(g => g && g.connected);
    // The touch controls are there from the start, step aside once a controller is played with (a connected one alone
    // may only be the simulator passing the Mac's through), and come back when the screen is touched.
    const played = found.find(inUse);
    const nativeInUse = nativePad && (nativePad.down || [nativePad.lx, nativePad.ly, nativePad.rx, nativePad.ry, nativePad.lt, nativePad.rt].some(a => Math.abs(a) > 0.3));
    if (touchScreen && !scripted) {
        if (seenControllers === -1) showTouch();
        if (touchShown && (played || nativeInUse)) hideTouch();
    }
    // The controller played with is the input now (and in the preview it stays the keyboard).
    if (played) use('controller', familyOf(played.id), played.id);
    else if (nativeInUse) use('controller', vendorFamily(nativePad.vendor));
    if (!scripted && found.length !== seenControllers) { seenControllers = found.length; log(`Lamp: ${found.length} controller${found.length === 1 ? '' : 's'} connected.`); }
    for (let i = 0; i < 4; i++) {
        let pad = found[i] ? gamepadPad(found[i]) : { connected: false, lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, down: 0 };
        if (i === 0) {
            if (scripted) pad = Object.assign({}, scripted);
            else {
                if (nativePad) merge(pad, nativePad);
                if (readsKeyboard) merge(pad, keyboardPad());
                merge(pad, Object.assign({}, touch, { down: touch.down | tapped }));
                tapped = 0;
            }
            pad.connected = true;
        }
        pad.pressed = pad.down & ~before[i];
        pad.released = before[i] & ~pad.down;
        before[i] = pad.down;
        pads[i] = pad;
    }
}

// What the frame function returns is handed back: in the preview a promise from it (lamp-phaser.js's, while a scene
// loads) is waited for before the next frame.
function step(dt) {
    readPads();
    time += dt;
    const said = frameFunction({ dt, time, number, width: WIDTH, height: HEIGHT, pads });
    number++;
    return said;
}

// MARK: The frame rate, measured on the device

// Every ten seconds of play the log says how fast frames really came, so the agent sees the device's own frame rate,
// not the preview's fixed 1/60 s. And when frames run slow the game is drawn smaller and scaled up to the screen, a
// step at a time: on whatever device it is, a scene that fills the screen with pixels is the usual cost, and fewer
// pixels the usual cure. A step that doesn't make frames faster is undone and no more are tried, since then the
// drawing isn't what's slow (a busy frame function, or a screen that refreshes only 30 times a second).
const SCALES = [1, 0.75, 0.5], SLOW = 45;
let level = 0, adapting = true, rateBefore = 0, lastTick = 0;
const report = { frames: 0, time: 0, slowest: 0 }, check = { times: [], time: 0, warm: false };

function drawScale(to) {
    level = to;
    check.warm = false;
    renderer.setSize(Math.round(WIDTH * SCALES[level]), Math.round(HEIGHT * SCALES[level]), false);
}
// A page that sizes its own canvas (`fill`) is drawn at whatever it chose.
let fills = false;
const drawn = () => fills ? `${renderer.domElement.width}x${renderer.domElement.height}`
    : `${Math.round(WIDTH * SCALES[level])}x${Math.round(HEIGHT * SCALES[level])}`;

function measure(now) {
    const ms = lastTick ? now - lastTick : 0;
    lastTick = now;
    // A page out of sight gets no frames: the gap is a pause, not a slow frame.
    if (!ms || ms > 1000) return;
    report.frames++; report.time += ms; report.slowest = Math.max(report.slowest, ms);
    if (report.time >= 10000) {
        log(`Lamp: ${Math.round(report.frames * 1000 / report.time)} frames a second (frames ${(report.time / report.frames).toFixed(1)} ms on average, slowest ${report.slowest.toFixed(1)} ms), drawn at ${drawn()}.`);
        report.frames = report.time = report.slowest = 0;
    }
    if (!adapting) return;
    check.times.push(ms); check.time += ms;
    // Two seconds a check, after a second left out as play starts and after each change of size, for the shaders
    // compiled, files read and buffers made then. The rate is the typical frame's, the median: one long hitch (a
    // window shown, a file read) isn't a device too slow to draw.
    if (check.time < (check.warm ? 2000 : 1000)) return;
    const sorted = check.times.sort((a, b) => a - b), rate = 1000 / sorted[sorted.length >> 1], warm = check.warm;
    check.times = []; check.time = 0; check.warm = true;
    if (!warm) return;
    if (rateBefore) {
        if (rate < rateBefore * 1.15) {
            drawScale(level - 1);
            adapting = false;
            log(`Lamp: drawing smaller didn't make frames faster (${Math.round(rateBefore)} a second, then ${Math.round(rate)}), so the game is drawn at ${drawn()} again.`);
            return;
        }
        rateBefore = 0;
    }
    if (rate < SLOW && level < SCALES.length - 1) {
        rateBefore = rate;
        drawScale(level + 1);
        log(`Lamp: frames were slow (${Math.round(rate)} a second), so the game is now drawn at ${drawn()} and scaled up to the screen.`);
    }
}

// Fits the canvas to the window at the console's shape, black around it.
function fit() {
    const canvas = renderer.domElement, scale = Math.min(innerWidth / WIDTH, innerHeight / HEIGHT);
    canvas.style.cssText = `position:fixed;left:${(innerWidth - WIDTH * scale) / 2}px;top:${(innerHeight - HEIGHT * scale) / 2}px;width:${WIDTH * scale}px;height:${HEIGHT * scale}px`;
}

// The game: `renderer` a three.js WebGLRenderer the runtime sizes and places, `init` run once (and waited for, so it may
// load files), `frame(f)` each frame with f.dt, f.time, f.number and f.pads (pads[0] the first controller: lx, ly, rx,
// ry -1 to 1 with up positive, lt and rt 0 to 1, buttons as BUTTON bits in down, pressed and released). `touch` names
// the buttons the touch controls show (BUTTON.A | BUTTON.B | BUTTON.MENU unless given; BUTTON.RSTICK adds a right stick),
// or `false` for a page that draws touch controls of its own. `keyboard: false` is for a page that reads the keys itself:
// the keyboard then isn't the first pad as well, so a key isn't heard twice. The preview's script is the first pad either way.
// The renderer may be a WebGLRenderer or, from 'three/webgpu', a WebGPURenderer (initialized before game() is called). A 2D
// game calls phaser() from lamp-phaser.js instead, which calls this with Phaser's canvas.
// `sharp: true` keeps it drawn at 1920x1080 however slow frames are (the log still says how fast they come).
// `fill: true` is for a page laid out at the window's size, as a web page is (a strategy game whose HUD is the page's own
// HTML, made for phones as well as TVs): the page puts the canvas where it wants it and sizes it itself, drawing it
// smaller when frames run slow, and the runtime only measures and logs the frame rate.
// `snapshot`, `restore`, `busy`, `assetChanged` and `dispose` keep the player's place through a change Lamp makes while
// the game is played (see "Changes while it's played" below).
export async function game({ renderer: given, init, frame, touch: buttons, keyboard = true, sharp = false, fill = false,
                             snapshot, restore, busy, assetChanged, dispose }) {
    // The game's code run again in place for a change calls this again: the page, the frame loop's clock and whatever
    // the game kept stay, and the new init starts from where the player was.
    const again = runningAgain;
    if (again) again.called = true;
    const old = renderer;
    renderer = given;
    fills = fill;
    adapting = !sharp && !fill;
    // Drawn at full size from here (setSize below), however small the code run before drew it.
    level = 0; rateBefore = 0; check.times = []; check.time = 0; check.warm = false;
    frameFunction = frame;
    hooks = { snapshot, restore, busy, assetChanged, dispose };
    // A renderer the new code didn't keep goes with the old code (its canvas went with the old page).
    if (again && old && old !== given && !isKept(old)) { try { old.dispose && old.dispose(); } catch (e) {} }
    if (buttons === false) drawsTouch = false;
    else if (buttons != null) touchButtons = buttons;
    readsKeyboard = keyboard !== false;
    if (!fill) {
        renderer.setPixelRatio(1);
        renderer.setSize(WIDTH, HEIGHT, false);
    }
    document.documentElement.style.background = document.body.style.background = '#000';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    // A game's page is played, not read: nothing on it is selected, magnified or called up by a long press.
    document.body.style.webkitUserSelect = document.body.style.userSelect = 'none';
    document.body.style.webkitTouchCallout = 'none';
    document.body.style.touchAction = 'none';
    if (!fill) {
        document.body.append(renderer.domElement);
        fit();
        if (!fitting) { fitting = true; listen(window, 'resize', fit); }
    }
    // Where the player was, if the page is opened again for a change: known before init, so the game starts there.
    if (again) { pending = { state: again.state, gen: again.change.gen }; reopened = true; taken = false; }
    else if (!preview) { await claim(); keepPage(); }
    // In the preview a start-up that fails ends the play with what it said, rather than leaving Lamp waiting for frames.
    if (init) {
        try { await init({ width: WIDTH, height: HEIGHT }); } catch (e) {
            if (again) return ranAgainFailed(again, e);
            if (taken) return startFresh(e);
            log(`Error: ${e && e.message || e}`);
            if (preview) { window.webkit.messageHandlers.lampPreview.postMessage({ done: true, failed: String(e && e.message || e), logs }); return; }
            throw e;
        }
    }
    if (preview) { if (again) ranAgain(again); return runPreview(); }
    await putBack();
    if (again) ranAgain(again);
    // One loop at a time: the game's code run again starts a new one, and the old one stops at its next frame.
    const mine = ++loops;
    reopenedFrame = 0;
    let last = 0;
    const loop = now => {
        if (mine !== loops) return;
        const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
        last = now;
        measure(now);
        try { step(dt); } catch (e) {
            // New code swapped in or run again that fails as it runs goes back out the safe way: the page opens again
            // from where the player was before it.
            if (swapGuard) { log(`Error: ${e && e.message || e}`); return swapFailed(e); }
            throw e;
        }
        // The first frame drawn from a snapshot has gone without an error: from here an error is the game's own.
        guarding = false;
        shoot();
        // Opened again for a change: it's on screen with this first frame.
        if (shownFor != null && !curtain && !runningAgain && reopenedFrame++ > 0) { tellHost(shownFor, 'shown'); shownFor = null; }
        lift();
        live();
        nextFrame(loop);
    };
    nextFrame(loop);
}

// MARK: Changes while it's played
//
// Lamp changes the game while the person plays it, and puts each change into the running game when it can, so the
// world it built (the scene, the renderer, geometry, compiled shaders) and the player stay as they are:
//
// - Files the game loaded through the runtime (asset(), texture(), model(), sound.load()): the runtime puts a new copy
//   of what it loaded in itself, and then calls the game's `assetChanged(path)` for each changed file, which replaces
//   anything of the game's own made from it (a material from a shader's source, a clone of a model, a level read from
//   JSON) and returns true when it has.
// - A stylesheet the page links: the new one replaces it.
// - A module of the game's that takes its new versions: one that calls `hot(import.meta).accept()` (below). Its new
//   version runs, and what it exports is put into what the running game holds: each exported class gets the new
//   methods (so every object made from it, made before or after, runs the new code with its own fields kept), each
//   exported plain object the new functions and the values the change changed (its other values, which the game may
//   have changed as it ran, stay), and each exported array the new contents when the change changed them. A module that doesn't take its changes is swapped through the modules that import
//   it: when every one of them, or one above it, takes them, it runs again for them, and they take theirs.
//
// Anything else runs the game's code again in place, keeping the player's place, the page, the renderer and what the
// game kept (see "Running the game's code again" below): the HTML, a module nothing above takes changes for (the one
// that starts the game, as a rule), a class whose constructor or fields changed (objects already made have the old
// fields) or that has private members (#name), an exported function or value that changed (whoever imported it holds
// the old one), or code a module's exported functions may use, changed outside its classes. Where that can't be done
// (a change to the import map, modules that import each other in a circle) the page opens again. The log says which,
// and why. Just before, `snapshot()` gives what matters of where the game is (the level, the player's position, the
// camera, the score, the mode, which menu or overlay is open…) as plain JSON. The new code starts straight there: `pendingRestore()` gives that state while the game starts (in init, or in a Phaser scene's
// init or create), so the game builds the place it was in rather than its title or intro, and the runtime calls
// nothing more. A game that doesn't read it and has `restore(state)` is started as usual and then given the state,
// before its first frame is drawn. A game without either starts again, from its own save() and load(). If starting
// from the state throws (init, a scene's create, restore or the first frame), the game starts fresh, and the log says
// so. New code swapped in or run again that throws in its first second opens the page again from the place before.
// While `busy()` is true (a match or a round under way, a race, a fight) a change that runs the code again waits, and
// goes in at the next moment busy() is false (a pause, between rounds); the person can also put it in at once. A swap
// goes in at once, busy or not. Where the app around the page has no Reload of Lamp's own, the page shows a small
// "Reload to apply" to press.
// Wherever else the game is played (Android, the Xbox, a TV, a phone), a change reaches it when Lamp installs it there
// again: the runtime keeps the latest snapshot, and the new copy restores it once, when it opens.
//
// A module that takes its changes ends with
//
//   hot(import.meta).accept();
//
// and keeps its state in objects made from the classes it exports (the game holds them: `new Traffic(scene)`), with
// its tuning in constants or plain objects it reads where it uses them, rather than copied into fields as an object is
// made: what a constructor built or copied stays as it was until the code runs again. Everything a module defines
// that the game calls goes out through its exports, classes above all; a class it keeps to itself keeps its old
// methods. `accept(next, { changed })` takes a function, called once the new version is in, with its exports and the
// names of what changed in them (`Traffic.update`, `TUNING.topSpeed`); it does what the change needs done that the
// swap doesn't (build again what a changed method built once), and returns false to have the code run again
// instead. For what a module makes at its top level (a listener, an element, a timer), `hot(import.meta).dispose(data
// => …)` takes it away as the old version goes, keeping in `data` what the next needs, which reads it as
// `hot(import.meta).data`. Nothing here runs in Lamp's preview or where changes come by an install.

let hooks = {}, started = false, waiting = null, pill = null;
// The place this copy starts in (claim()), whether the game read it (pendingRestore()), and whether an error now means
// the state didn't take.
let pending = null, reopened = false, taken = false, guarding = false;
const host = () => window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.lampLive;
const tellHost = (gen, state, why) => { try { const h = host(); h && h.postMessage(why ? { gen, state, why } : { gen, state }); } catch (e) {} };
// What a change of these is, is code: swapped in, or the page is opened again for it.
const CODE = /\.(m?js|html?|css)$/i;
// Each copy of the page names its build (lamp-build.js, written with lamp-device.js), so a snapshot is restored only by a
// newer build. A copy without one restores only what the page itself kept for its reopening.
let buildID = null;
const build = preview ? Promise.resolve(null) : import('./lamp-build.js').then(m => (buildID = m.default), () => null);
const LIVE = 'lamp.live', LAST = 'lamp.live.last';
const store = kind => { try { return kind === 'session' ? sessionStorage : localStorage; } catch (e) { return null; } };

function takeSnapshot() {
    if (!hooks.snapshot) return null;
    try {
        const state = hooks.snapshot();
        return state === undefined ? null : JSON.parse(JSON.stringify(state));
    } catch (e) { log(`Lamp: snapshot() failed (${e && e.message || e}).`); return null; }
}

function isBusy() {
    try { return !!(hooks.busy && hooks.busy()); } catch (e) { return false; }
}

// Lamp's app around the page hands it a change: `changed` the files changed, `gen` its number, `now` when the person
// pressed Reload, `pill` when the page is to show its own Reload. Returns true: the page takes changes. One change is
// put in at a time, so one arriving during a swap waits for it.
let queue = Promise.resolve();
window.__lampLive = change => {
    if (preview) return false;
    changes = Math.max(changes + 1, change.gen || 0);
    queue = queue.then(() => {
        if (waiting) change = { ...change, changed: [...new Set([...waiting.changed, ...change.changed])] };
        waiting = null;
        return apply(change);
    }).catch(e => log(`Lamp: ${e && e.message || e}`));
    return true;
};

async function apply(change) {
    const paths = (change.changed || []).map(clean);
    // Not started yet: nothing to keep.
    if (!started) { tellHost(change.gen, 'reloading'); location.reload(); return; }
    // Where the player is before anything is swapped, for the page to open from should the swap not take.
    const before = takeSnapshot(), began = performance.now();
    const said = [];
    let why = paths.length ? null : 'nothing to put in', touched = false;
    for (const path of paths.filter(p => !CODE.test(p))) {
        let done = false;
        for (const swap of swaps.get(path) || []) { try { await swap(); done = true; } catch (e) { log(`Lamp: couldn't put in the new ${path} (${e && e.message || e}).`); } }
        if (hooks.assetChanged) { try { if (await hooks.assetChanged(path)) done = true; } catch (e) { log(`Error: assetChanged('${path}'): ${e && e.message || e}`); } }
        if (done) said.push(path);
        else why = why || (loaded.has(path) ? `${path} changed, and nothing in the running game takes the new one in`
            : `nothing the game loaded through lamp-game.js is made from ${path}`);
    }
    const code = paths.filter(p => CODE.test(p));
    if (!why && code.length) {
        const swapped = await swapCode(code);
        if (swapped.why) { why = swapped.why; touched = swapped.touched; } else said.push(...swapped.said);
    }
    if (!why) {
        log(`Lamp: put in ${said.join('; ')} while the game ran (${Math.round(performance.now() - began)} ms).`);
        if (code.length) { swapGuard = { until: time + 1, change, state: before }; markStale(code); }
        tellHost(change.gen, 'swapped');
        return;
    }
    change = { ...change, why };
    // Half swapped is no place to wait in: the code runs again now, from where the player was before.
    if (isBusy() && !change.now && !touched) {
        waiting = change;
        log(`Lamp: a change that needs the game's code run again (${why}) waits for a pause in the game.`);
        tellHost(change.gen, 'held', why);
        if (change.pill) showPill();
        return;
    }
    return startAgain(change, touched ? before : undefined);
}

// A change that can't be swapped in: the game's code runs again in place, keeping the page, the renderer and what the
// game kept, or, where that can't be done, the page opens again. Either way from `state`, where the player was.
function startAgain(change, state = takeSnapshot()) {
    const why = canRunAgain(change);
    if (why) return reopen({ ...change, why: `${change.why}; ${why}` }, state);
    return runAgain(change, state);
}

// Opens the page again with the new code, with the player's place kept for the new code to restore: where it is now, or
// `state` taken before a swap that didn't take.
function reopen(change, state = takeSnapshot()) {
    // A warm preview can't open its page again with a new play: Lamp starts it cold instead.
    if (preview) { window.webkit.messageHandlers.lampPreview.postMessage({ done: true, again: false, logs }); return; }
    hidePill();
    try { store('session').setItem(LIVE, JSON.stringify({ state, input: current, padName, gen: change.gen })); } catch (e) {}
    const why = change.why ? ` (${change.why})` : '';
    log(state == null ? `Lamp: opening the game again for a change of its code${why}; it has no snapshot(), so it starts from its own saves.`
        : `Lamp: opening the game again for a change of its code${why}, keeping where the player was.`);
    tellHost(change.gen, 'reloading', change.why);
    location.reload();
}

// Each frame: a waiting change goes in once the game isn't busy; the latest snapshot is kept for the next install.
let keptAt = 0;
function live() {
    if (swapGuard && time > swapGuard.until) swapGuard = null;
    if (waiting && !isBusy()) { const change = waiting; waiting = null; queue = queue.then(() => startAgain(change)).catch(e => log(`Lamp: ${e && e.message || e}`)); }
    if (hooks.snapshot && time - keptAt >= 5) { keptAt = time; keepLast(); }
}

// MARK: Swapping code in
//
// What the runtime knows of the game's modules: each that called hot(), by its path beside the page, with every version
// of it that has run (its exports, and the values of its plain objects as each version made them, to tell what a
// change changed from what the game changed as it ran), its source as the last version ran, and the address its
// latest version was loaded from, which a module loaded afresh imports it by.
const modules = new Map(), latest = new Map(), loading = new Set();
// The swap that went in last, watched for its first second: an error in it opens the page again.
let swapGuard = null, versionCount = 0;
// Where the page's files are, read when first needed: a copy of the runtime run outside a page has no URL.
let base = null;
const pageBase = () => base || (base = new URL('.', location.href));
const pathOf = url => {
    try {
        const u = new URL(url, location.href), b = pageBase();
        if (u.protocol !== b.protocol || u.host !== b.host || !u.pathname.startsWith(b.pathname)) return null;
        return decodeURIComponent(u.pathname.slice(b.pathname.length));
    } catch (e) { return null; }
};
const addressOf = path => new URL(path, pageBase()).href;
const source = f => Function.prototype.toString.call(f);
const isClass = v => typeof v === 'function' && /^class\b/.test(source(v));
const isPlain = v => !!v && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const valueText = v => { try { return typeof v === 'function' ? 'function ' + source(v) : JSON.stringify(v) ?? String(v); } catch (e) { return String(v); } };
// Code as it reads with its comments and spacing gone, so a comment added beside a method changes nothing.
const bare = text => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').replace(/\s+/g, '');

// A module's handle on its changes while the game is played (see "Changes while it's played" above): `accept()` takes
// them, `dispose(fn)` takes away what this version made as it goes, `data` is what the last version's disposers kept,
// and `keep(key, build)` a part of the game kept when its code runs again (see "Running the game's code again").
export function hot(meta) {
    const path = pathOf(meta && meta.url);
    const quiet = { data: {}, accept() {}, dispose() {}, keep(key, build) { return build(); } };
    if ((preview && !preview.warm) || path == null || (!preview && !host())) return quiet;
    let entry = modules.get(path);
    if (!entry) modules.set(path, entry = { path, accepts: false, onAccept: null, disposers: [], data: {}, versions: [], text: null });
    // Each version says for itself whether it takes the next, and what to take away when it goes.
    entry.accepts = false;
    entry.onAccept = null;
    entry.disposers = [];
    if (!loading.has(path) && !entry.versions.length) {
        // The version the page loaded first, which every module that imported it holds: known once it has run.
        import(meta.url).then(ns => { if (!entry.versions.length) entry.versions.push(versionOf(ns)); }, () => {});
        fetch(meta.url, { cache: 'no-store' }).then(a => a.ok ? a.text() : null).then(t => { if (entry.text == null) entry.text = t; }, () => {});
    }
    return {
        data: entry.data,
        accept(callback) { entry.accepts = true; entry.onAccept = typeof callback === 'function' ? callback : null; },
        dispose(callback) { if (typeof callback === 'function') entry.disposers.push(callback); },
        keep(key, build, options) { return keep(path, key, build, options); },
    };
}

function versionOf(ns) {
    const made = {};
    for (const name of Object.keys(ns)) {
        if (Array.isArray(ns[name])) made[name] = valueText(ns[name]);
        if (!isPlain(ns[name])) continue;
        made[name] = {};
        for (const key of Object.keys(ns[name])) made[name][key] = valueText(ns[name][key]);
    }
    return { ns, made };
}

// The game's modules, read from the page: what each imports (static imports, re-exports and import() of a written-out
// path), so a change can go up to the modules that take it. Kept between changes, and read again for what changed.
const imports = new Map(), texts = new Map();
const SPECIFIER = /(\bimport\s*\(\s*|\bfrom\s*|\bimport\s+)(['"])([^'"\n]+)\2/g;
// Lamp's own files beside the page never change with the game, and three.js is large: they aren't read.
const lampOwn = path => /^(three|rapier|phaser)\//.test(path) || /^lamp(-[\w-]+)?\.js$/.test(path);
let importMap = null;
function resolve(specifier, from) {
    if (/^\.{0,2}\//.test(specifier)) return new URL(specifier, from).href;
    if (/^[a-z][\w+.-]*:/i.test(specifier)) return specifier;
    if (!importMap) {
        importMap = {};
        for (const s of document.querySelectorAll('script[type="importmap"]')) { try { Object.assign(importMap, JSON.parse(s.textContent).imports || {}); } catch (e) {} }
    }
    if (importMap[specifier]) return new URL(importMap[specifier], location.href).href;
    const prefix = Object.keys(importMap).filter(k => k.endsWith('/') && specifier.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    return prefix ? new URL(importMap[prefix] + specifier.slice(prefix.length), location.href).href : null;
}
const importsIn = (text, from) => [...text.matchAll(SPECIFIER)].map(m => pathOf(resolve(m[3], from) || '')).filter(p => p != null && !lampOwn(p));
// The names a module's imports give it, each with the module it comes from: `a`, `b` and `ns` in
// `import a, { x as b } from './m.js'` and `import * as ns from './n.js'`.
const BINDINGS = /\bimport\s+([\w$*{}\s,]+?)\s+from\s*(['"])([^'"\n]+)\2/g;
const bindings = new Map();
function bindingsIn(text, from) {
    const names = new Map();
    for (const m of text.matchAll(BINDINGS)) {
        const path = pathOf(resolve(m[3], from) || '');
        if (path == null || lampOwn(path)) continue;
        const clause = m[1].replace(/\*\s*as\s+/, '').replace(/[{}]/g, ',');
        for (const part of clause.split(',')) { const name = part.trim().split(/\s+as\s+/).pop(); if (name) names.set(name, path); }
    }
    return names;
}

async function readText(path) {
    const answer = await fetch(`${addressOf(path)}?lamp=${changes}`, { cache: 'no-store' });
    if (!answer.ok) throw new Error(`${path} couldn't be read`);
    return answer.text();
}

// `page` is the document whose module scripts start the game: the running page, or the page's HTML as it is now when
// the game's code runs again. The page's own scripts (inline) are kept by name in `inline`.
let rootPaths = [];
const inline = new Map();
async function readModules(changed, page = document) {
    for (const path of changed) imports.delete(path);
    const roots = [];
    for (const s of page.querySelectorAll('script[type="module"]')) {
        const src = s.getAttribute('src');
        const path = src ? pathOf(new URL(src, location.href).href) : `the page's own script ${roots.length + 1}`;
        if (path == null) continue;
        if (!src) { imports.set(path, importsIn(s.textContent, location.href)); bindings.set(path, bindingsIn(s.textContent, location.href)); inline.set(path, s.textContent); }
        roots.push(path);
    }
    rootPaths = roots;
    const unread = () => [...new Set([...roots, ...[...imports.values()].flat()])].filter(p => !imports.has(p));
    let next = unread();
    while (next.length) {
        await Promise.all(next.map(async path => {
            const text = await readText(path).catch(() => '');
            if (changed.includes(path)) texts.set(path, text);
            imports.set(path, importsIn(text, addressOf(path)));
            bindings.set(path, bindingsIn(text, addressOf(path)));
        }));
        next = unread();
    }
    return roots;
}

// Puts changed modules and stylesheets into the running game: { said } what went in, or { why } it couldn't, with
// `touched` when something was already taken away or swapped, so the page must open again now.
async function swapCode(paths) {
    const html = paths.find(p => /\.html?$/i.test(p));
    if (html) return { why: `${html} changed` };
    const code = paths.filter(p => /\.m?js$/i.test(p)), styles = paths.filter(p => /\.css$/i.test(p));
    const said = [];
    if (code.length) {
        const swapped = await swapModules(code);
        if (swapped.why) return swapped;
        said.push(...swapped.said);
    }
    for (const path of styles) {
        const links = [...document.querySelectorAll('link[rel~="stylesheet"]')].filter(l => pathOf(l.href) === path);
        if (!links.length) return { why: `no link in the page loads ${path}`, touched: said.length > 0 };
        try {
            await Promise.all(links.map(old => new Promise((done, failed) => {
                const next = old.cloneNode();
                next.href = `${addressOf(path)}?lamp=${++versionCount}`;
                next.onload = () => { old.remove(); done(); };
                next.onerror = () => { next.remove(); failed(new Error(`${path} didn't load`)); };
                old.after(next);
            })));
        } catch (e) { return { why: e.message, touched: said.length > 0 }; }
        said.push(path);
    }
    return { said };
}

async function swapModules(changed) {
    const roots = await readModules(changed);
    const importers = new Map();
    for (const [path, deps] of imports) for (const dep of deps) importers.set(dep, [...(importers.get(dep) || []), path]);
    const takes = path => { const m = modules.get(path); return !!(m && m.accepts && m.versions.length && m.text != null); };
    // Every module the change runs again, up to those that take it (the boundaries).
    const again = new Set(), boundaries = new Set();
    const up = path => {
        if (again.has(path)) return null;
        again.add(path);
        if (takes(path)) { boundaries.add(path); return null; }
        const by = importers.get(path) || [];
        if (!by.length) return roots.includes(path) ? `${path} doesn't take changes while the game runs` : `nothing imports ${path}`;
        for (const above of by) { const why = up(above); if (why) return why; }
        return null;
    };
    for (const path of changed) {
        if (lampOwn(path)) return { why: `Lamp's own ${path} changed` };
        if (!imports.has(path)) return { why: `nothing imports ${path}` };
        const why = up(path);
        if (why) return { why };
    }
    // Run again in order, what each imports before it.
    const order = [], seen = new Map();
    const visit = path => {
        if (seen.get(path) === 2) return true;
        if (seen.get(path) === 1) return false;
        seen.set(path, 1);
        for (const dep of imports.get(path) || []) if (again.has(dep) && !visit(dep)) return false;
        seen.set(path, 2);
        order.push(path);
        return true;
    };
    for (const path of again) if (!visit(path)) return { why: `${path} is in a circle of modules that import each other` };

    // What the old versions made at their top level goes before the new ones run, as each asked.
    let touched = false;
    for (const path of order) {
        const m = modules.get(path);
        for (const dispose of m ? m.disposers : []) {
            touched = true;
            try { await dispose(m.data); } catch (e) { log(`Error: dispose in ${path}: ${e && e.message || e}`); }
        }
    }
    // The new versions, each importing the others' new versions and the rest of the game as it runs: a module none of
    // whose imports changed is loaded from its own address, with a new query; one that imports another that runs again
    // is loaded from its source with those imports pointed at the new versions.
    // Each new version's exports as it made them, read before any of the game's values are put into them.
    const loaded = new Map(), addresses = new Map(), made = new Map();
    for (const path of order) {
        const address = `${addressOf(path)}?lamp=${++versionCount}`;
        const deps = imports.get(path) || [];
        loading.add(path);
        try {
            const text = texts.get(path) ?? await readText(path);
            texts.set(path, text);
            let from = address;
            if (deps.some(d => again.has(d) || latest.has(d))) {
                const written = text.replace(SPECIFIER, (all, lead, quote, specifier) => {
                    const target = resolve(specifier, addressOf(path));
                    const p = target && pathOf(target);
                    if (!target) return all;
                    return lead + quote + (p != null && addresses.has(p) ? addresses.get(p) : p != null && latest.has(p) ? latest.get(p) : target) + quote;
                }).replace(/\bimport\.meta\b/g, `({ url: ${JSON.stringify(address)}, resolve: s => new URL(s, ${JSON.stringify(address)}).href })`);
                from = URL.createObjectURL(new Blob([written], { type: 'text/javascript' }));
            }
            loaded.set(path, await import(from));
            // The new version's top level has run (listeners, elements): from here a refusal opens the page again at once.
            touched = true;
            made.set(path, versionOf(loaded.get(path)));
            addresses.set(path, from);
        } catch (e) {
            return { why: `${path} didn't load (${e && e.message || e})`, touched: true };
        } finally { loading.delete(path); }
    }
    // Each boundary's new exports must fit what the game holds of the old ones.
    for (const path of boundaries) {
        const rerun = (imports.get(path) || []).find(d => again.has(d));
        const why = fits(modules.get(path), loaded.get(path), texts.get(path), path, rerun);
        if (why) return { why, touched };
    }
    const said = [];
    for (const path of boundaries) {
        const m = modules.get(path), ns = loaded.get(path);
        const changedNames = putIn(m, ns);
        m.versions.push(made.get(path));
        m.text = texts.get(path);
        if (m.onAccept) {
            try {
                if (await m.onAccept(ns, { changed: changedNames }) === false) return { why: `${path} asked for the page to be opened again`, touched: true };
            } catch (e) { return { why: `accept in ${path} failed (${e && e.message || e})`, touched: true }; }
        }
        said.push(changedNames.length ? `${path} (${changedNames.slice(0, 8).join(', ')}${changedNames.length > 8 ? '…' : ''})` : path);
    }
    for (const path of order) {
        latest.set(path, addresses.get(path));
        const m = modules.get(path);
        if (m && !boundaries.has(path)) { m.versions.push(made.get(path)); m.text = texts.get(path); }
        if (!boundaries.has(path)) said.push(`${path}, run again for the modules that import it`);
    }
    for (const path of changed) texts.delete(path);
    return { said };
}

// Why the new exports can't be put into the old, or null when they can.
function fits(m, ns, text, path, rerun) {
    const last = m.versions[m.versions.length - 1].ns;
    let holdsCode = false;
    for (const name of Object.keys(ns)) {
        const now = ns[name], was = last[name];
        // A new export: nothing holds an old one.
        if (was === undefined) continue;
        if (isClass(now) || isClass(was)) {
            if (!isClass(now) || !isClass(was)) return `${name} in ${path} is a class in one version and not the other`;
            if (shell(was) !== shell(now)) return `the constructor or fields of ${name} in ${path} changed`;
            // An object's private members belong to the class that made it: a method of a new version can't read them.
            if (PRIVATE.test(source(now))) return `${name} in ${path} has private members (#name), which a new version's methods can't reach`;
        } else if (typeof now === 'function' || typeof was === 'function') {
            if (typeof now !== 'function' || typeof was !== 'function' || source(now) !== source(was)) return `${path} exports the function ${name}, which changed`;
            holdsCode = true;
        } else if ((isPlain(now) && isPlain(was)) || (Array.isArray(now) && Array.isArray(was))) {
            continue;
        } else if (valueText(now) !== valueText(was)) {
            return `${path} exports ${name}, whose value changed`;
        } else if (now && typeof now === 'object') holdsCode = true;
    }
    if (holdsCode && rerun) return `${path} exports functions, which go on using the old ${rerun}`;
    if (holdsCode && outside(m.text, last) !== outside(text, ns)) return `code outside the classes in ${path} changed, which what it exports may use`;
    return null;
}

// A use of a private member: `this.#speed`, `#speed in other`.
const PRIVATE = /\.\s*#[A-Za-z_$]|#[A-Za-z_$][\w$]*\s+in\b/;

// A class as it reads without its methods, accessors and static methods: its constructor, fields and what it extends.
function shell(C) {
    let text = source(C);
    for (const [from, skip] of [[C.prototype, ['constructor']], [C, ['length', 'name', 'prototype']]]) {
        for (const key of Reflect.ownKeys(from)) {
            if (skip.includes(key)) continue;
            const d = Object.getOwnPropertyDescriptor(from, key);
            for (const f of [d.value, d.get, d.set]) if (typeof f === 'function') { const s = source(f), i = text.indexOf(s); if (i >= 0) text = text.slice(0, i) + text.slice(i + s.length); }
        }
    }
    return bare(text);
}

// A module's source without its exported classes.
function outside(text, ns) {
    for (const value of Object.values(ns)) if (isClass(value)) { const s = source(value), i = text.indexOf(s); if (i >= 0) text = text.slice(0, i) + text.slice(i + s.length); }
    return bare(text);
}

// Puts a new version's exports into every earlier version's, which the game holds; returns what changed.
function putIn(m, ns) {
    const changed = new Set(), last = m.versions[m.versions.length - 1];
    for (const name of Object.keys(ns)) {
        const now = ns[name];
        const earlier = [...new Set(m.versions.map(v => v.ns[name]))].filter(v => v !== undefined && v !== now);
        if (isClass(now)) {
            for (const C of earlier) for (const key of putClass(C, now)) changed.add(`${name}.${key}`);
            // An object made by either version is an instance of both.
            const family = [...earlier, now];
            // A subclass inherits this static: it answers for its own class alone.
            function has(o) { return (family.includes(this) ? family : [this]).some(K => Function.prototype[Symbol.hasInstance].call(K, o)); }
            for (const K of family) Object.defineProperty(K, Symbol.hasInstance, { value: has, configurable: true });
        } else if (Array.isArray(now)) {
            // An array is taken whole: the change's new one when it changed it, else the one the game has.
            const held = earlier[earlier.length - 1];
            if (valueText(now) !== last.made[name] || !Array.isArray(held)) {
                changed.add(name);
                for (const A of earlier) if (Array.isArray(A)) A.splice(0, A.length, ...now);
            } else now.splice(0, now.length, ...held);
        } else if (isPlain(now)) {
            const before = last.made[name] || {}, held = earlier[earlier.length - 1];
            for (const key of Object.keys(now)) {
                const fresh = valueText(now[key]);
                if (fresh !== before[key]) changed.add(`${name}.${key}`);
                // What the change changed goes in; what it didn't keeps what the game made of it, in both copies.
                if (fresh !== before[key] || typeof now[key] === 'function' || !held || !(key in held)) for (const O of earlier) O[key] = now[key];
                else now[key] = held[key];
            }
        }
    }
    return [...changed];
}

function putClass(C, N) {
    const changed = [];
    const code = d => d ? [d.value, d.get, d.set].filter(f => typeof f === 'function').map(source).join('\n') : '';
    for (const [from, to, skip] of [[N.prototype, C.prototype, ['constructor']], [N, C, ['length', 'name', 'prototype', Symbol.hasInstance]]]) {
        // A method the new version no longer has goes, so an old object falls back to what it inherits, as a new one does.
        for (const key of Reflect.ownKeys(to)) {
            if (skip.includes(key) || Object.prototype.hasOwnProperty.call(from, key)) continue;
            const d = Object.getOwnPropertyDescriptor(to, key);
            if (!d.get && !d.set && typeof d.value !== 'function') continue;
            delete to[key];
            changed.push(String(key));
        }
        for (const key of Reflect.ownKeys(from)) {
            if (skip.includes(key)) continue;
            const d = Object.getOwnPropertyDescriptor(from, key);
            if (!d.get && !d.set && typeof d.value !== 'function') continue;
            if (code(Object.getOwnPropertyDescriptor(to, key)) !== code(d)) changed.push(String(key));
            Object.defineProperty(to, key, d);
        }
    }
    return changed;
}

// MARK: Running the game's code again
//
// A change that can't be swapped in (the HTML, the module that starts the game, a class whose fields changed, an
// exported function) runs the game's code again in place, as a page opened again would but without opening it: the old
// code's frame loop stops, its `dispose` and the modules' disposers run, and what it left running is taken away (see
// below); the page's HTML is put back as the new version has it (Lamp's own elements stay), every module of the game
// runs again in order (loaded from its source with its imports pointed at the new versions, as a swap loads one), and
// the module that starts the game calls game() again, whose init starts from the snapshot taken before (read with
// pendingRestore(), or given to restore()). What stays is what a reload loses: the WebGL or WebGPU context and the
// shaders compiled for it, the files the runtime loaded, the sound, the controllers, and every part the game kept.
//
// A part is kept with `hot(import.meta).keep(key, build, { inputs, dispose })`: the first time it calls build() and
// returns what that made (or its promise), and when the code runs again it returns the same thing without building it,
// unless the module that kept it, or one it imports, changed since, the build function's own code changed, or one of
// `inputs` isn't the same as before (another part's result it's built from, as a dependency list goes), or a file it
// loaded through the runtime (asset(), texture(), model(), sound.load()) changed. The module that
// starts the game imports everything and changes often, so what it keeps goes by the modules whose imports the build
// function names, and theirs: a change of its own code outside the build function keeps what it kept. A part that's
// built again, or not asked for any more, goes: `dispose(value)` when given, else a three.js object is taken out of its
// scene and its geometry and materials let go, and anything with dispose() or destroy() has it called.
//
//   const renderer = await hot(import.meta).keep('renderer', async () => { const r = new THREE.WebGPURenderer(); await r.init(); return r; });
//   const blocks = live.keep('blocks', () => buildBlocks(landmarks.colliders), { inputs: [landmarks] });
//
// What the game's code leaves running is watched from the start: listeners it adds (to the window, the document or
// anything else), timers, sound contexts it makes itself and workers. Each is taken away when the code runs again,
// unless a part kept it (made while a keep's build ran). A module's own state starts again with it, as on a reload.
// Running again isn't tried, and the page opens again as before, where the import map or a script that isn't a module
// changed, Lamp's own files changed, modules import each other in a circle, or the page has no module scripts; and new
// code that fails as it runs again, before init is done or in its first second, opens the page again from the same
// snapshot.

let runningAgain = null, loops = 0, fitting = false, pageText = null, watching = false, reopenedFrame = 0;
// What the game kept, by the module and key it was kept with.
const kept = new Map();
// Above 0 while a part's build function runs: what it starts belongs to the part, and stays.
let keeping = 0;

function keep(path, key, build, options = {}) {
    const { dispose, inputs = [] } = typeof options === 'function' ? { dispose: options } : options;
    const id = `${path} ${key}`, text = source(build), had = kept.get(id), again = runningAgain;
    const same = had && had.inputs.length === inputs.length && inputs.every((v, i) => Object.is(v, had.inputs[i]));
    // In the preview a part whose async build drew random numbers while it waited is built again: how many were its
    // own can't be told, and a play must give the numbers a cold one does.
    if (had && !had.stale && had.text === text && same && !(preview && had.draws == null)) {
        had.used = true;
        if (again) again.kept.push(key);
        // The random numbers its build drew are drawn past, so what comes after gets the numbers it got then.
        for (let i = 0; i < (had.draws || 0); i++) random();
        return had.value;
    }
    if (had) letGo(had);
    const entry = { path, key, text, inputs, dispose: typeof dispose === 'function' ? dispose : null, used: true, stale: false,
                    value: undefined, made: undefined, assets: new Set(), draws: 0 };
    // What the build starts as it runs belongs to the part. An async build's later work can't be told from other code
    // that runs while it waits, so of what's started meanwhile only what's the part's own stays with it: listeners on
    // the part (its object, its canvas, an element inside it) and a worker or sound context that is the part or one of
    // its values. The rest is watched as the game's; a timer started while it waits can't be told apart, so a part that
    // started one still running is built again when the code next runs (a part keeps a timer it starts before its first
    // await).
    keeping++;
    building.push(entry);
    const drawn = draws;
    let value;
    try { value = build(); } finally { keeping--; building.pop(); entry.draws = draws - drawn; }
    if (value && typeof value.then === 'function') {
        const waiting = { added: [], made: [], timers: [], assets: entry.assets };
        keepsWaiting.add(waiting);
        value = Promise.resolve(value).finally(() => keepsWaiting.delete(waiting));
        const drawnBefore = draws;
        value.then(v => { entry.made = v; entry.timers = waiting.timers; if (draws !== drawnBefore) entry.draws = null; own(v, waiting); },
            () => { if (kept.get(id) === entry) kept.delete(id); });
    } else entry.made = value;
    entry.value = value;
    kept.set(id, entry);
    if (again && had) again.built.push(key);
    return value;
}

const isKept = v => [...kept.values()].some(k => k.made === v);

// Async builds still running, each with the listeners added while it ran.
const keepsWaiting = new Set();
// The parts whose build is running now, and the files the runtime loaded for each (`took`): a change to one of those
// files builds the part again.
const building = [];
function took(path) {
    loaded.add(path);
    for (const entry of building) entry.assets.add(path);
    for (const waiting of keepsWaiting) waiting.assets.add(path);
}
// The parts' timer lists a timer's callback runs for, while it runs.
let timedFor = null;
function own(made, waiting) {
    const parts = [made, made && made.domElement, made && made.canvas].filter(o => o && typeof o === 'object');
    const of = target => parts.some(p => p === target || (p.contains && target.nodeType && p.contains(target)));
    const values = made && typeof made === 'object' ? [made, ...Object.values(made)] : [made];
    for (const [thing, end] of waiting.made) if (values.includes(thing)) owned.delete(end);
    for (const [target, listener] of waiting.added) {
        if (!of(target)) continue;
        const list = listenersOf.get(target), i = list ? list.indexOf(listener) : -1;
        if (i >= 0) list.splice(i, 1);
    }
}

function letGo(k) {
    Promise.resolve(k.value).then(v => {
        try {
            if (k.dispose) return k.dispose(v);
            if (v && v.isObject3D) {
                v.removeFromParent();
                v.traverse(o => { if (o.geometry) o.geometry.dispose(); for (const m of [o.material].flat()) if (m && m.dispose) m.dispose(); });
            } else if (v && typeof v.dispose === 'function') v.dispose();
            else if (v && typeof v.destroy === 'function') v.destroy(true);
        } catch (e) { log(`Lamp: letting go of ${k.key} kept in ${k.path} failed (${e && e.message || e}).`); }
    }, () => {});
}

// What a module imports, all the way down.
function below(path) {
    const all = new Set(), next = [path];
    while (next.length) for (const dep of imports.get(next.pop()) || []) if (!all.has(dep)) { all.add(dep); next.push(dep); }
    return all;
}

// What was kept by a changed module, or by one it imports, is built again when the code next runs. The module that
// starts the game imports everything and changes often, so what it kept goes by what the build function names: the
// modules whose imports it uses, and theirs.
function markStale(paths) {
    for (const k of kept.values()) {
        if (k.stale) continue;
        let deps;
        // A game bundled into one file (from TypeScript) imports nothing of its own: a change anywhere in it is its own.
        if (rootPaths.includes(k.path) && (bindings.get(k.path) || new Map()).size) {
            deps = new Set();
            for (const [name, from] of bindings.get(k.path) || []) {
                if (!new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, '\\$')}\\b`).test(k.text)) continue;
                deps.add(from);
                for (const dep of below(from)) deps.add(dep);
            }
        } else { deps = below(k.path); deps.add(k.path); }
        if (paths.some(p => deps.has(p) || k.assets.has(p))) k.stale = true;
    }
}

const pagePath = () => pathOf(location.href.split(/[?#]/)[0]) || 'index.html';
// The page's HTML as this copy started, to tell what of it a change changed.
function keepPage() {
    if (!watching) return;
    readText(pagePath()).then(t => { if (pageText == null) pageText = t; }, () => {});
}
const parse = text => new DOMParser().parseFromString(text, 'text/html');
// What of a page can't change under modules that have run: the import map and the scripts that aren't modules.
const fixed = page => JSON.stringify([...page.querySelectorAll('script')].filter(s => s.type !== 'module')
    .map(s => [s.type, s.getAttribute('src'), s.getAttribute('src') ? '' : s.textContent.trim()]));

// Why the code can't run again in place for a change, or null when it can.
function canRunAgain(change) {
    if (!watching) return 'the game\'s code runs again in place only where Lamp puts changes into the open game';
    if (!frameFunction) return 'the game hadn\'t started';
    const own = (change.changed || []).map(clean).find(p => lampOwn(p));
    if (own) return `Lamp's own ${own} changed`;
    return null;
}

async function runAgain(change, state) {
    const began = performance.now(), why = change.why;
    const cannot = reason => reopen({ ...change, why: `${why}; ${reason}` }, state);
    const paths = (change.changed || []).map(clean);
    let text, page;
    try { text = await readText(pagePath()); page = parse(text); } catch (e) { return cannot('its page couldn\'t be read'); }
    if (fixed(page) !== fixed(pageText != null ? parse(pageText) : document)) return cannot('its import map or a script that isn\'t a module changed');
    const classic = doc => [...doc.querySelectorAll('script[src]')].filter(s => s.type !== 'module' && s.type !== 'importmap')
        .map(s => pathOf(new URL(s.getAttribute('src'), location.href).href));
    const script = paths.find(p => classic(page).includes(p) || classic(document).includes(p));
    if (script) return cannot(`${script}, a script that isn't a module, changed`);
    // Every module of the game, in order, what each imports before it.
    const order = [];
    try {
        const roots = await readModules(paths.filter(p => /\.m?js$/i.test(p)), page);
        if (!roots.length) return cannot('the page has no module scripts');
        const seen = new Map();
        const visit = path => {
            if (seen.get(path) === 2) return;
            if (seen.get(path) === 1) throw new Error(`${path} is in a circle of modules that import each other`);
            seen.set(path, 1);
            for (const dep of imports.get(path) || []) visit(dep);
            seen.set(path, 2);
            order.push(path);
        };
        for (const root of roots) visit(root);
    } catch (e) { return cannot(e.message); }
    markStale(paths);

    tellHost(change.gen, 'rerun', why);
    log(`Lamp: running the game's code again in place for a change (${why}), keeping where the player was.`);
    // The frame on screen now, held there until the new code draws its first.
    const still = preview ? null : await new Promise(done => { shooting = done; after(250, () => { if (shooting === done) { shooting = null; done(null); } }); });
    const again = runningAgain = { change, state, began, called: false, kept: [], built: [], done: null };
    const done = new Promise(resolve => { again.done = resolve; });
    // The old code stops: its frame loop, what it asked to have taken away, and what it left running.
    loops++;
    started = false;
    swapGuard = null;
    hidePill();
    const leaving = hooks;
    hooks = {};
    try { if (leaving.dispose) await leaving.dispose(); } catch (e) { log(`Error: dispose: ${e && e.message || e}`); }
    for (const [path, m] of modules) {
        for (const dispose of m.disposers) { try { await dispose(m.data); } catch (e) { log(`Error: dispose in ${path}: ${e && e.message || e}`); } }
        m.disposers = [];
    }
    // A part whose async build started a timer still running loses it now, so it's built again.
    for (const k of kept.values()) if ((k.timers || []).some(t => intervals.has(t) || timeouts.has(t))) k.stale = true;
    takeAwayLeft();
    listeners.clear();
    for (const voice of voices) sound.stop(voice);
    voices.clear();
    if (musicVoice) { sound.stop(musicVoice); musicVoice = null; }
    for (const k of kept.values()) k.used = false;
    await putPage(page, paths, still);
    pageText = text;
    // The new code, each module once, in order, importing the others' new versions.
    const addresses = new Map();
    for (const path of order) {
        const own = inline.has(path), address = own ? location.href : `${addressOf(path)}?lamp=${++versionCount}`;
        loading.add(path);
        try {
            const code = own ? inline.get(path) : (texts.get(path) ?? await readText(path));
            texts.set(path, code);
            const base = own ? location.href : addressOf(path);
            const written = code.replace(SPECIFIER, (all, lead, quote, specifier) => {
                const target = resolve(specifier, base);
                if (!target) return all;
                const p = pathOf(target);
                return lead + quote + (p != null && addresses.has(p) ? addresses.get(p) : target) + quote;
            }).replace(/\bimport\.meta\b/g, `({ url: ${JSON.stringify(address)}, resolve: s => new URL(s, ${JSON.stringify(address)}).href })`);
            const from = URL.createObjectURL(new Blob([written], { type: 'text/javascript' }));
            addresses.set(path, from);
            if (rootPaths.includes(path)) {
                // The module that starts the game: what it awaits may be the whole start, so it isn't waited for here.
                import(from).catch(e => ranAgainFailed(again, e));
                continue;
            }
            const ns = await import(from);
            const m = modules.get(path);
            if (m) { m.versions.push(versionOf(ns)); m.text = code; }
            latest.set(path, from);
        } catch (e) {
            return ranAgainFailed(again, `${path} didn't load (${e && e.message || e})`);
        } finally { loading.delete(path); }
    }
    for (const path of paths) texts.delete(path);
    for (const path of rootPaths) latest.set(path, addresses.get(path));
    after(120000, () => { if (runningAgain === again) ranAgainFailed(again, 'the game didn\'t start again within two minutes'); });
    return done;
}

// The page as the new HTML has it: what isn't a script in its head (a stylesheet it already links stays, unless it
// changed), and its body, with Lamp's own elements (the touch controls, the Reload button) kept.
async function putPage(page, paths, still) {
    const head = document.head, links = [...head.querySelectorAll('link[rel~="stylesheet"]')], loads = [], placed = [];
    for (const node of [...page.head.children]) {
        if (node.tagName === 'SCRIPT') continue;
        if (node.matches('link[rel~="stylesheet"]')) {
            const path = pathOf(new URL(node.getAttribute('href'), location.href).href);
            const have = links.find(l => pathOf(l.href) === path && !placed.includes(l));
            if (have && !paths.includes(path)) { placed.push(have); continue; }
            const fresh = document.adoptNode(node);
            if (path != null) fresh.href = `${addressOf(path)}?lamp=${++versionCount}`;
            loads.push(new Promise(done => { fresh.onload = fresh.onerror = done; after(5000, done); }));
            placed.push(fresh);
            continue;
        }
        placed.push(document.adoptNode(node));
    }
    // In the new page's order, since the order of stylesheets is the order of their rules. A stylesheet already linked
    // moves only when it's out of that order (moved, it's read again); the scripts and what goes stay where they are
    // until the new stylesheets have loaded, so the page is never shown unstyled.
    let before = null;
    for (const node of placed) {
        let at = before ? before.nextSibling : head.firstChild;
        while (at && (at.nodeType !== 1 || at.tagName === 'SCRIPT' || !placed.includes(at))) at = at.nextSibling;
        if (node !== at) head.insertBefore(node, at);
        before = node;
    }
    await Promise.all(loads);
    for (const node of [...head.children]) if (node.tagName !== 'SCRIPT' && !placed.includes(node)) node.remove();
    const body = document.body;
    for (const a of [...body.attributes]) body.removeAttribute(a.name);
    for (const a of [...page.body.attributes]) body.setAttribute(a.name, a.value);
    // The old page stays in view, still, over the new one until the new code has drawn (`lift`): its elements go last,
    // so the new code finds its own by id, and the frame it showed stands where the canvas was.
    const canvas = renderer && renderer.domElement;
    if (preview) { body.replaceChildren(...[...page.body.childNodes].map(n => document.adoptNode(n))); return; }
    const old = [...body.childNodes].filter(n => n !== touchLayer && n !== pill && n !== canvas && n !== curtain);
    if (curtain) curtain.remove();
    curtain = document.createElement('div');
    curtain.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none';
    if (still) curtain.append(still);
    curtain.append(...old);
    // Scripts from the new page don't run as they go in: the modules run from runAgain.
    body.replaceChildren(...[...page.body.childNodes].map(n => document.adoptNode(n)), curtain, ...[touchLayer, pill].filter(Boolean));
}

// The frame just drawn, as a picture placed where the game's canvas is, for runAgain to hold on screen; asked of the
// next frame, since a WebGL canvas keeps what it drew only until the frame is shown.
let shooting = null, curtain = null, lifting = 0;
// The change whose new code is about to be on screen, for `shown`: after a run in place as the old frame goes, after a
// reload at the first frame.
let shownFor = null;
function shoot() {
    if (!shooting) return;
    const done = shooting;
    shooting = null;
    let still = null;
    try {
        const drawn = renderer && renderer.domElement;
        const canvas = drawn && (drawn.tagName === 'CANVAS' ? drawn : drawn.querySelector && drawn.querySelector('canvas'));
        if (canvas && canvas.width && canvas.height) {
            const r = canvas.getBoundingClientRect();
            still = document.createElement('canvas');
            still.width = canvas.width; still.height = canvas.height;
            still.getContext('2d').drawImage(canvas, 0, 0);
            still.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
        }
    } catch (e) { still = null; }
    done(still);
}
// Once the new code has drawn a couple of frames, the old page held over it fades away.
function lift() {
    if (!curtain || runningAgain || ++lifting < 3) return;
    // The change is on screen now: Lamp's light crosses the window as the old frame fades.
    if (shownFor != null) { tellHost(shownFor, 'shown'); shownFor = null; }
    const going = curtain;
    curtain = null;
    lifting = 0;
    going.style.transition = 'opacity 0.2s';
    going.style.opacity = '0';
    after(250, () => going.remove());
}

function ranAgain(again) {
    runningAgain = null;
    lifting = 0;
    shownFor = again.change.gen;
    // No old frame held (a page with no canvas to picture): on screen at the next frame.
    if (!curtain) after(0, () => { if (shownFor === again.change.gen) { tellHost(shownFor, 'shown'); shownFor = null; } });
    for (const [id, k] of kept) if (!k.used) { letGo(k); kept.delete(id); }
    const said = [again.kept.length ? `kept ${again.kept.join(', ')}` : '', again.built.length ? `built again ${again.built.join(', ')}` : ''].filter(Boolean);
    log(`Lamp: the game's code ran again in place${said.length ? ` (${said.join('; ')})` : ''} in ${Math.round(performance.now() - again.began)} ms.`);
    swapGuard = { until: time + 1, change: again.change, state: again.state };
    again.done();
}

// New code that fails before it's running opens the page again, from the same place.
function ranAgainFailed(again, e) {
    if (runningAgain !== again) return new Promise(() => {});
    runningAgain = null;
    log(`Error: ${e && e.message || e}`);
    reopen({ ...again.change, why: `the game's code run again failed (${e && e.message || e})` }, again.state);
    return new Promise(() => {});
}
if (!preview) {
    // Until the new code is running (`ranAgain`), anything it throws opens the page again: half a start is no place to play.
    listen(window, 'error', e => { if (runningAgain) ranAgainFailed(runningAgain, e.error || e.message); });
    listen(window, 'unhandledrejection', e => { if (runningAgain) ranAgainFailed(runningAgain, e.reason); });
}

// What the game's code leaves running: each listener by its target (held weakly, so an element thrown away goes with
// its listeners), timers, sound contexts and workers.
const listening = new Set(), listenersOf = new WeakMap(), timeouts = new Set(), intervals = new Set(), owned = new Set();
const captureOf = options => typeof options === 'boolean' ? options : !!(options && options.capture);
function watch() {
    watching = true;
    EventTarget.prototype.addEventListener = function (type, fn, options) {
        browser.listen.call(this, type, fn, options);
        if (fn == null || keeping) return;
        let list = listenersOf.get(this);
        if (!list) {
            listenersOf.set(this, list = []);
            listening.add(new WeakRef(this));
            if (listening.size > 4000) for (const ref of listening) if (!ref.deref()) listening.delete(ref);
        }
        const listener = { type, fn, capture: captureOf(options) };
        list.push(listener);
        for (const waiting of keepsWaiting) waiting.added.push([this, listener]);
    };
    EventTarget.prototype.removeEventListener = function (type, fn, options) {
        browser.unlisten.call(this, type, fn, options);
        const list = listenersOf.get(this), capture = captureOf(options);
        if (list) { const i = list.findIndex(l => l.type === type && l.fn === fn && l.capture === capture); if (i >= 0) list.splice(i, 1); }
    };
    // A timer started while an async part's build waits is recorded against that part, and so is every timer its
    // callbacks start after (one that schedules its next tick), so the part is built again while any is running.
    const owners = () => [...[...keepsWaiting].map(waiting => waiting.timers), ...(timedFor || [])];
    const runFor = (lists, fn) => lists.length ? (...a) => { const was = timedFor; timedFor = lists; try { return fn(...a); } finally { timedFor = was; } } : fn;
    window.setTimeout = function (fn, ms, ...rest) {
        if (keeping || typeof fn !== 'function') return browser.setTimeout.call(window, fn, ms, ...rest);
        const lists = owners(), run = runFor(lists, fn);
        const id = browser.setTimeout.call(window, (...a) => { timeouts.delete(id); run(...a); }, ms, ...rest);
        timeouts.add(id);
        for (const list of lists) list.push(id);
        return id;
    };
    window.clearTimeout = id => { timeouts.delete(id); browser.clearTimeout.call(window, id); };
    window.setInterval = function (fn, ms, ...rest) {
        if (keeping || typeof fn !== 'function') return browser.setInterval.call(window, fn, ms, ...rest);
        const lists = owners();
        const id = browser.setInterval.call(window, runFor(lists, fn), ms, ...rest);
        intervals.add(id);
        for (const list of lists) list.push(id);
        return id;
    };
    window.clearInterval = id => { intervals.delete(id); browser.clearInterval.call(window, id); };
    const owning = (Made, end) => {
        const Watched = function (...args) {
            const made = new Made(...args);
            if (!keeping) {
                const ending = () => end(made);
                owned.add(ending);
                for (const waiting of keepsWaiting) waiting.made.push([made, ending]);
            }
            return made;
        };
        Watched.prototype = Made.prototype;
        return Watched;
    };
    if (browser.AudioContext) window.AudioContext = window.webkitAudioContext = owning(browser.AudioContext, c => c.state !== 'closed' && c.close());
    if (browser.Worker) window.Worker = owning(browser.Worker, w => w.terminate());
}

function takeAwayLeft() {
    for (const ref of listening) {
        const target = ref.deref();
        if (!target) continue;
        for (const { type, fn, capture } of listenersOf.get(target) || []) browser.unlisten.call(target, type, fn, capture);
        listenersOf.delete(target);
    }
    listening.clear();
    for (const id of timeouts) browser.clearTimeout.call(window, id);
    for (const id of intervals) browser.clearInterval.call(window, id);
    timeouts.clear(); intervals.clear();
    for (const end of owned) { try { end(); } catch (e) {} }
    owned.clear();
}

// Swapped code that fails in its first second: the page opens again from where the player was before the swap.
function swapFailed(e) {
    const guard = swapGuard;
    swapGuard = null;
    reopen({ ...guard.change, why: `the code swapped in failed as it ran (${e && e.message || e})` }, guard.state);
}
if (!preview) window.addEventListener('error', e => { if (swapGuard) swapFailed(e.error || e.message); });

function keepLast() {
    if (!buildID) return;
    const state = takeSnapshot();
    if (state == null) return;
    try { store('local').setItem(LAST, JSON.stringify({ build: buildID, at: Date.now(), state, input: current })); } catch (e) {}
}
if (!preview) {
    window.addEventListener('pagehide', () => { if (started) keepLast(); });
    document.addEventListener('visibilitychange', () => { if (started && document.hidden) keepLast(); });
}

// Where this copy of the page starts: the place it kept for its reopening, or else the latest snapshot of an older
// build (Lamp installed a new one since). Taken from storage as it's read, so it's restored at most once.
async function claim() {
    const session = store('session'), local = store('local');
    let said = null;
    try { said = JSON.parse(session.getItem(LIVE) || 'null'); session.removeItem(LIVE); reopened = !!said; } catch (e) {}
    if (said && said.fresh) { tellHost(said.gen, 'fresh'); return; }
    const id = await build;
    if (!said) {
        try {
            const last = JSON.parse(local.getItem(LAST) || 'null');
            // Within a quarter of an hour: an install that follows a change, not a game opened again another day.
            if (last && id && last.build !== id && Date.now() - last.at < 15 * 60 * 1000) { said = last; local.removeItem(LAST); }
        } catch (e) {}
    }
    if (said && said.input && said.input.kind) { current = said.input; padName = said.padName || ''; for (const changed of listeners) try { changed(input()); } catch (e) {} }
    pending = said;
    if (said && said.state != null) {
        // An error while the game starts from the state (in a Phaser scene's create, say, or the first frame) is the
        // state not taking.
        listen(window, 'error', e => { if (guarding) startFresh(e.error || e.message); });
    }
}

// The state the game was in before a change of its code (what snapshot() gave), for the game to start from; null when
// it starts fresh, and once it has started. Read it in init (or a Phaser scene's init or create) and build that place
// instead of the title or intro: reading it is the restore, and restore() isn't called.
export function pendingRestore() {
    if (started || !pending || pending.state == null) return null;
    taken = guarding = true;
    return pending.state;
}

// After init: a game that didn't read the state is given it through restore(), before its first frame.
async function putBack() {
    const said = pending;
    if (reopened && said && !said.fresh) shownFor = said.gen;
    if (taken) {
        log(reopened ? 'Lamp: the game started where it was, with the new code.' : 'Lamp: the game started where it was before it was installed again.');
        tellHost(said.gen, 'restored');
    } else if (said && said.state != null && hooks.restore) {
        guarding = true;
        try {
            await hooks.restore(said.state);
            log(reopened ? 'Lamp: the game is back where it was, with the new code.' : 'Lamp: the game is back where it was before it was installed again.');
            tellHost(said.gen, 'restored');
        } catch (e) { return startFresh(e); }
    } else if (reopened && said && !said.fresh) tellHost(said.gen, 'started');
    pending = null;
    started = true;
}

// Half put back is worse than fresh: the page opens once more without the snapshot.
function startFresh(e) {
    if (!guarding && !taken) return;
    guarding = taken = false;
    log(`Lamp: couldn't put the game back where it was (${e && e.message || e}), so it starts fresh.`);
    try { store('session').setItem(LIVE, JSON.stringify({ fresh: true, gen: pending && pending.gen })); } catch (e2) {}
    location.reload();
    return new Promise(() => {});
}

function showPill() {
    if (pill) { pill.style.display = 'block'; return; }
    pill = document.createElement('button');
    pill.textContent = 'Reload to apply';
    pill.style.cssText = 'position:fixed;z-index:20;left:50%;transform:translateX(-50%);bottom:calc(14px + env(safe-area-inset-bottom));'
        + 'padding:8px 16px;border:0;border-radius:18px;background:rgba(20,20,24,.72);color:#fff;font:600 15px -apple-system,system-ui,sans-serif;'
        + '-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)';
    const press = e => { e.stopPropagation(); e.preventDefault(); if (waiting) { const change = waiting; waiting = null; queue = queue.then(() => startAgain(change)); } };
    listen(pill, 'pointerdown', press);
    document.body.append(pill);
}
function hidePill() { if (pill) pill.style.display = 'none'; }

// MARK: Lamp's preview: the script played out of sight, a picture where it says
//
// A preview Lamp keeps open between looks (`warm`) is handed each new play with the files changed since the last:
// the game's code runs again in place from a fresh start (see "Running the game's code again"), with the clock, the
// seed, the saves and the log as a new page has them, keeping what the game keeps, and the script plays. So only the
// first play of a while builds the whole game. A kept part skips the random numbers its build drew, so the same script
// gives the same pictures as a cold play; one whose async build drew any while it waited is built again. Returns false
// when it can't (the game hasn't started, or is starting), and Lamp opens a new preview.
if (preview && preview.warm) {
    window.__lampPreviewAgain = next => {
        if (!frameFunction || runningAgain) return false;
        preview.script = next.script || [];
        // Files loaded afresh, under a new query, as a change in the open game has them.
        changes++;
        seed = 1n; clock = 0; time = 0; number = 0;
        saved.clear(); played.clear(); logs.length = 0;
        scripted = null; before = [0, 0, 0, 0];
        queue = queue.then(() => startAgain({ gen: 0, changed: next.changed || [], why: 'a new play in the preview' }, null))
            .catch(e => window.webkit.messageHandlers.lampPreview.postMessage({ done: true, again: false, logs: [String(e && e.message || e)] }));
        return true;
    };
}

async function runPreview() {
    // Lamp answers each picture once it has taken it, of the whole page as drawn (the canvas and anything over it).
    const post = message => window.webkit.messageHandlers.lampPreview.postMessage(message);
    let mostCalls = 0, mostTriangles = 0, triangles = 0, frames = 0;
    const limit = 60 * 600;
    for (const line of preview.script) {
        const words = line.trim().split(/\s+/);
        if (words[0] === 'shot') {
            await post({ shot: words[1] });
            continue;
        }
        if (words[0] !== 'hold') continue;
        const [n, lx, ly, rx, ry, lt, rt, down] = words.slice(1).map(Number);
        scripted = { lx, ly, rx, ry, lt, rt, down: down | 0 };
        for (let i = 0; i < n && frames < limit; i++) {
            window.__lampAdvance(1000 / 60);
            renderer.info.reset();
            renderer.info.autoReset = false;
            try { const waiting = step(1 / 60); if (waiting && waiting.then) await waiting; } catch (e) { log(`Error: ${e.message}`); post({ done: true, failed: e.message, logs }); return; }
            const info = renderer.info.render;
            mostCalls = Math.max(mostCalls, info.calls);
            mostTriangles = Math.max(mostTriangles, info.triangles);
            triangles += info.triangles;
            frames++;
        }
    }
    const said = [...played.entries()].map(([name, count]) => count > 1 ? `${name} ${count} times` : name);
    post({ done: true, logs,
           stats: `${frames} frames (${(frames / 60).toFixed(1)} s of play); at most ${mostCalls} draws and ${mostTriangles} triangles in a frame, ${Math.round(frames ? triangles / frames : 0)} triangles a frame on average.`,
           sound: said.length ? 'played ' + said.join(', ') : 'nothing played' });
}

// Watched from here, after the runtime's own listeners: only where Lamp puts changes into the open game, or plays
// again in a preview it keeps warm.
if (preview ? preview.warm : host()) watch();
