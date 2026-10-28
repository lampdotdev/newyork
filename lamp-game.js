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

// MARK: Random numbers, the same each preview play (xorshift64*, as the C++ kit has it)

let seed = preview ? 1n : BigInt(Date.now()) | 1n;
const mask = (1n << 64n) - 1n;
export function random() {
    seed ^= seed >> 12n; seed ^= (seed << 25n) & mask; seed ^= seed >> 27n;
    return Number(((seed * 0x2545F4914F6CDD1Dn) & mask) >> 40n) / 16777216;
}
if (preview) {
    // three.js and the game's own code may reach for these: in the preview they're the game's clock and seed too.
    Math.random = random;
    let clock = 0;
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
    loaded.add(clean(path));
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
    loaded.add(clean(path));
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
    loaded.add(clean(path));
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
    if (!audio) { try { audio = new AudioContext({ sampleRate: 48000 }); } catch (e) { return null; } }
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
        loaded.add(clean(path));
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
        if (musicVoice && ctx) { const old = musicVoice; old.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.3); setTimeout(() => sound.stop(old), 1500); }
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
        zone.addEventListener('pointerdown', e => { id = e.pointerId; sx = e.clientX; sy = e.clientY; zone.setPointerCapture(id); move(e); });
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
        zone.addEventListener('pointermove', move);
        const end = e => {
            if (e.pointerId !== id) return;
            id = null; touch[axes[0]] = touch[axes[1]] = 0;
            ring.style.display = knob.style.display = 'none';
            rest.style.display = '';
        };
        zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end);
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
        b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off);
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
const drawn = () => `${Math.round(WIDTH * SCALES[level])}x${Math.round(HEIGHT * SCALES[level])}`;

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
// `snapshot`, `restore`, `busy` and `assetChanged` keep the player's place through a change Lamp makes while the game is
// played (see "Changes while it's played" below).
export async function game({ renderer: given, init, frame, touch: buttons, keyboard = true, sharp = false,
                             snapshot, restore, busy, assetChanged }) {
    renderer = given;
    adapting = !sharp;
    frameFunction = frame;
    hooks = { snapshot, restore, busy, assetChanged };
    if (buttons === false) drawsTouch = false;
    else if (buttons != null) touchButtons = buttons;
    readsKeyboard = keyboard !== false;
    renderer.setPixelRatio(1);
    renderer.setSize(WIDTH, HEIGHT, false);
    document.documentElement.style.background = document.body.style.background = '#000';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    // A game's page is played, not read: nothing on it is selected, magnified or called up by a long press.
    document.body.style.webkitUserSelect = document.body.style.userSelect = 'none';
    document.body.style.webkitTouchCallout = 'none';
    document.body.style.touchAction = 'none';
    document.body.append(renderer.domElement);
    fit();
    window.addEventListener('resize', fit);
    // Where the player was, if the page is opened again for a change: known before init, so the game starts there.
    if (!preview) await claim();
    // In the preview a start-up that fails ends the play with what it said, rather than leaving Lamp waiting for frames.
    if (init) {
        try { await init({ width: WIDTH, height: HEIGHT }); } catch (e) {
            if (taken) return startFresh(e);
            log(`Error: ${e && e.message || e}`);
            if (preview) { window.webkit.messageHandlers.lampPreview.postMessage({ done: true, failed: String(e && e.message || e), logs }); return; }
            throw e;
        }
    }
    if (preview) return runPreview();
    await putBack();
    let last = 0;
    const loop = now => {
        const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
        last = now;
        measure(now);
        step(dt);
        // The first frame drawn from a snapshot has gone without an error: from here an error is the game's own.
        guarding = false;
        live();
        requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
}

// MARK: Changes while it's played
//
// Lamp changes the game while the person plays it. A change of files the game loaded through the runtime (asset(),
// texture(), model(), sound.load()) goes into the running game: the runtime puts a new copy of what it loaded in itself,
// and then calls the game's `assetChanged(path)` for each changed file, which replaces anything of the game's own made
// from it (a material from a shader's source, a clone of a model, a level read from JSON) and returns true when it has.
// A change of code (a .js, .html or .css file), or of a file nothing put in, opens the page again with the new code,
// keeping the player's place: just before, `snapshot()` gives what matters of where the game is (the level, the
// player's position, the camera, the score, the mode, which menu or overlay is open…) as plain JSON. The new copy
// starts straight there: `pendingRestore()` gives that state while the game starts (in init, or in a Phaser scene's
// init or create), so the game builds the place it was in rather than its title or intro, and the runtime calls
// nothing more. A game that doesn't read it and has `restore(state)` is started as usual and then given the state,
// before its first frame is drawn. A game without either starts again, from its own save() and load(). If starting
// from the state throws (init, a scene's create, restore or the first frame), the game starts fresh, and the log says so.
// While `busy()` is true (a match or a round under way, a race, a fight) a change of code waits, and goes in at the
// next moment busy() is false (a pause, between rounds); the person can also put it in at once. Where the app around the
// page has no Reload of Lamp's own, the page shows a small "Reload to apply" to press.
// Wherever else the game is played (Android, the Xbox, a TV, a phone), a change reaches it when Lamp installs it there
// again: the runtime keeps the latest snapshot, and the new copy restores it once, when it opens.

let hooks = {}, started = false, waiting = null, pill = null;
// The place this copy starts in (claim()), whether the game read it (pendingRestore()), and whether an error now means
// the state didn't take.
let pending = null, reopened = false, taken = false, guarding = false;
const host = () => window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.lampLive;
const tellHost = (gen, state) => { try { const h = host(); h && h.postMessage({ gen, state }); } catch (e) {} };
// What a change of these is, is code: the page is opened again for it.
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
// pressed Reload, `pill` when the page is to show its own Reload. Returns true: the page takes changes.
window.__lampLive = change => {
    if (preview) return false;
    if (waiting) change = { ...change, changed: [...new Set([...waiting.changed, ...change.changed])] };
    waiting = null;
    changes = Math.max(changes + 1, change.gen || 0);
    apply(change);
    return true;
};

async function apply(change) {
    const paths = (change.changed || []).map(clean);
    // Not started yet: nothing to keep.
    if (!started) { tellHost(change.gen, 'reloading'); location.reload(); return; }
    if (paths.length && !paths.some(p => CODE.test(p))) {
        let all = true;
        for (const path of paths) {
            let done = false;
            for (const swap of swaps.get(path) || []) { try { await swap(); done = true; } catch (e) { log(`Lamp: couldn't put in the new ${path} (${e && e.message || e}).`); } }
            if (hooks.assetChanged) { try { if (await hooks.assetChanged(path)) done = true; } catch (e) { log(`Error: assetChanged('${path}'): ${e && e.message || e}`); } }
            if (!done) all = false;
        }
        if (all) { log(`Lamp: put in ${paths.join(', ')} while the game ran.`); tellHost(change.gen, 'swapped'); return; }
    }
    if (isBusy() && !change.now) {
        waiting = change;
        tellHost(change.gen, 'held');
        if (change.pill) showPill();
        return;
    }
    reopen(change);
}

// Opens the page again with the new code, with the player's place kept for the new code to restore.
function reopen(change) {
    hidePill();
    const state = takeSnapshot();
    try { store('session').setItem(LIVE, JSON.stringify({ state, input: current, padName, gen: change.gen })); } catch (e) {}
    log(state == null ? 'Lamp: opening the game again for a change of its code; it has no snapshot(), so it starts from its own saves.'
        : 'Lamp: opening the game again for a change of its code, keeping where the player was.');
    tellHost(change.gen, 'reloading');
    location.reload();
}

// Each frame: a waiting change goes in once the game isn't busy; the latest snapshot is kept for the next install.
let kept = 0;
function live() {
    if (waiting && !isBusy()) { const change = waiting; waiting = null; reopen(change); }
    if (hooks.snapshot && time - kept >= 5) { kept = time; keepLast(); }
}

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
        window.addEventListener('error', e => { if (guarding) startFresh(e.error || e.message); });
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
    const press = e => { e.stopPropagation(); e.preventDefault(); if (waiting) { const change = waiting; waiting = null; reopen(change); } };
    pill.addEventListener('pointerdown', press);
    document.body.append(pill);
}
function hidePill() { if (pill) pill.style.display = 'none'; }

// MARK: Lamp's preview: the script played out of sight, a picture where it says

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
