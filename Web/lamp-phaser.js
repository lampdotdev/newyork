// Lamp's game runtime for a 2D game drawn with Phaser. Lamp writes this file before every build; don't edit it.
//
// A 2D game is Phaser scenes run by Lamp's runtime (lamp-game.js), which stays the one frame loop: Phaser's own loop is
// put to sleep once it has started, and each of the runtime's frames steps Phaser once, with the runtime's time. So the
// game is played at 1920x1080 scaled to the screen wherever it goes, and Lamp's preview plays it frame by frame at exactly
// 1/60 s with the same random numbers, as it plays a three.js game. Everything the player plays with comes from the
// runtime, not from Phaser: the controllers, the keyboard and the touch controls are one pad, `pad()` here, read in a
// scene's update; sound is lamp-game.js's `sound` (Phaser's own is off); saves are `save()` and `load()`. Phaser's
// keyboard and gamepad input are off, so a key is never heard twice; its pointer input (clicks on the Mac) is on.
//
//   import * as Phaser from 'phaser';
//   import { phaser, pad } from './lamp-phaser.js';
//   import { BUTTON, STICK, sound, save, load, random, log, label, glyph, onInput } from './lamp-game.js';
//   class Play extends Phaser.Scene {
//       constructor() { super('play'); }
//       preload() { this.load.image('hero', 'art/hero.png'); }
//       create() { this.hero = this.physics.add.sprite(200, 800, 'hero'); }
//       update(time, delta) { this.hero.setVelocityX(pad().lx * 600); }
//   }
//   phaser({ scenes: [Play], physics: { default: 'arcade', arcade: { gravity: { y: 2000 } } } });

import * as Phaser from 'phaser';
import { game, WIDTH, HEIGHT, random, log } from './lamp-game.js';

const preview = window.lampPreview || null;
const still = { connected: false, lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, down: 0, pressed: 0, released: 0 };

// The frame the runtime is stepping now: dt and time in seconds, number, and the pads.
let current = null;

// A controller as this frame reads it, pads[0] the first (the keyboard and the touch controls are part of it): lx, ly,
// rx, ry -1 to 1 with up positive, lt and rt 0 to 1, buttons as BUTTON bits in down, pressed and released. Read it in a
// scene's update; pressed and released hold for the one frame a button went down or up.
export function pad(index = 0) {
    return (current && current.pads[index]) || still;
}

// This frame as the runtime gives it ({ dt, time, number, pads }), for what wants seconds rather than Phaser's ms.
export function frame() { return current; }

// The Phaser.Game, once phaser() has started it.
export let phaserGame = null;

// A scene not yet started stays at INIT, so only these are on their way to running. A scene started from another's
// create (Boot's `this.scene.start('play')`) is first only an operation in the scene manager's queue, with no status
// of its own: it's on its way too, so that the game's first scenes are all made before the game is said to have
// started (and read pendingRestore() while it still gives the snapshot).
const STARTING = new Set([Phaser.Scenes.START, Phaser.Scenes.LOADING, Phaser.Scenes.CREATING]);
const queued = m => (m._queue && m._queue.length > 0) || (m._pending && m._pending.length > 0);
const starting = g => !g.isRunning || !g.scene.isBooted || queued(g.scene) || g.scene.scenes.some(s => STARTING.has(s.sys.settings.status));

// Waits, without stepping the game, until no scene is loading or being made: the loader's files arrive on their own,
// and the scene manager's queue (a scene started from another's create) is taken in as the game's step would.
async function settled(g) {
    const began = performance.now();
    let waited = 0;
    while (starting(g)) {
        await new Promise(done => setTimeout(done, 5));
        if (g.scene.isBooted) {
            g.scene.processQueue();
            for (const s of g.scene.scenes) if (s.sys.settings.status === Phaser.Scenes.LOADING) s.sys.load.update();
        }
        // The preview's clock is the game's, so waiting is counted in turns, about 30 s of them.
        if (++waited > 6000 || (!preview && performance.now() - began > 30000)) { log('Lamp: a scene was still loading after 30 s; playing on.'); return; }
    }
}

// Starts the game: `scenes` its Phaser.Scene classes, the first one started; `pixelArt` true for pixel art (sharp pixels,
// no smoothing, positions rounded); `physics` Phaser's physics config (Arcade for most games); `background` the color
// behind everything; `touch` and `keyboard` as game() in lamp-game.js takes them (the touch buttons a phone shows, or
// false for a game that draws its own; keyboard: false for a game that reads keys itself). `config` is anything more of
// Phaser's game config (`render`, `fps`…), never its size, scale, input, audio or loop, which are Lamp's. `snapshot`,
// `restore`, `busy` and `assetChanged` keep the player's place through a change, as game() takes them. The scenes are
// made during game()'s init, so pendingRestore() from lamp-game.js gives the snapshot in the first scene's init or
// create, and a game goes straight to where the player was without showing its title.
export async function phaser({ scenes, pixelArt = false, physics, background = '#000000', touch, keyboard, config = {},
                               snapshot, restore, busy, assetChanged }) {
    // What lamp-game.js fits to the screen at 1920x1080's shape: Phaser fits its canvas inside it (Phaser's FIT, so a
    // click is read where it lands however big the window is).
    const stage = document.createElement('div');
    let calls = 0, triangles = 0;
    const renderer = {
        domElement: stage,
        // Phaser draws its canvas at the game's own size; lamp-game.js's smaller drawing when frames are slow is a
        // three.js renderer's, so a Phaser game is always `sharp` (the log still says how fast frames come).
        setPixelRatio() {}, setSize() {},
        // What the preview counts: WebGL draws, and the triangles in them (Phaser draws two to a sprite).
        info: { autoReset: true, render: { get calls() { return calls; }, get triangles() { return triangles; } }, reset() { calls = triangles = 0; } },
    };
    let g = null;
    return game({
        renderer, touch, keyboard, sharp: true, snapshot, restore, busy, assetChanged,
        async init() {
            g = phaserGame = new Phaser.Game(Object.assign({}, config, {
                type: config.type ?? Phaser.AUTO, parent: stage, width: WIDTH, height: HEIGHT,
                scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.NO_CENTER, expandParent: false },
                backgroundColor: background, pixelArt, physics, scene: scenes,
                input: { keyboard: false, gamepad: false, mouse: true, touch: true },
                audio: { noAudio: true }, banner: false, disableContextMenu: true, canvasStyle: 'display:block',
                // Phaser's own random numbers (Phaser.Math.RND) start from the runtime's, the same every preview play.
                seed: [String(random())],
            }));
            await new Promise(done => g.isRunning ? done() : g.events.once(Phaser.Core.Events.READY, () => setTimeout(done, 0)));
            // One loop: the runtime's. Phaser's would run on the browser's frames, which the preview doesn't have.
            g.loop.sleep();
            const gl = g.renderer && g.renderer.gl;
            if (preview && gl) {
                const count = (draw, at) => function (mode, ...rest) {
                    calls++;
                    if (mode === gl.TRIANGLES) triangles += Math.floor(rest[at] / 3);
                    else if (mode === gl.TRIANGLE_STRIP || mode === gl.TRIANGLE_FAN) triangles += Math.max(0, rest[at] - 2);
                    return draw.call(this, mode, ...rest);
                };
                gl.drawArrays = count(gl.drawArrays, 1);
                gl.drawElements = count(gl.drawElements, 0);
            }
            log(`Lamp: Phaser ${Phaser.VERSION}, drawn with ${g.renderer && g.renderer.type === Phaser.WEBGL ? 'WebGL' : 'a 2D canvas'}.`);
            await settled(g);
        },
        frame(f) {
            current = f;
            const ms = f.time * 1000, delta = f.dt * 1000;
            g.loop.now = g.loop.time = ms;
            g.loop.delta = g.loop.rawDelta = delta;
            g.loop.frame = f.number;
            g.step(ms, delta);
            // In the preview a scene that starts loading mid-play is waited for, so a play is the same frames every time;
            // played for real, it loads while the game goes on.
            if (preview && starting(g)) return settled(g);
        },
    });
}
