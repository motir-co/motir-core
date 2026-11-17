import { describe, expect, it } from 'vitest';
import {
  BRIAN,
  CYCLIC,
  CYCLIC_STATES,
  DAY_NIGHT,
  RULE110,
  STYLE_IDS,
  cellular,
  drawerFor,
  mooreCount,
  packRgb,
  seeded,
  type BackgroundColours,
  type CellularSpec,
  type StyleId,
} from '../src/index';
import {
  PALETTE_MODES,
  fixtureColours,
  recordingCanvasFactory,
  recordingContext,
  type Op,
} from './helpers/recordingCanvas';

const W = 320;
const H = 200;
const focus = { x: 100, y: 60, w: 120, h: 80 };

const SPECS: Array<[string, CellularSpec]> = [
  ['cyclic', CYCLIC],
  ['brian', BRIAN],
  ['daynight', DAY_NIGHT],
  ['rule110', RULE110],
];

/** Draw frames at `times` on one drawer; return the main ops and each frame's image hash. */
function run(
  id: string,
  colours: BackgroundColours,
  style: StyleId = 'warm-editorial',
  times: number[] = [0],
  size: [number, number] = [W, H],
) {
  const make = drawerFor(id as never)!;
  const drawer = make();
  drawer.resize(size[0], size[1]);
  const off = recordingCanvasFactory();
  const main = recordingContext();
  for (const t of times) {
    drawer.frame(main.ctx, t, { colours, style, focus, createCanvas: off.create });
  }
  const hashes = off.made.flatMap((m) =>
    m.ops.filter((op) => op[0] === 'putImageData').map((op) => op[1] as number),
  );
  // The off-screen canvas object is not comparable by value; keep its draw size only.
  const ops: Op[] = main.ops.map((op) =>
    op[0] === 'drawImage' ? ['drawImage', ...op.slice(2)] : op,
  );
  return { ops, hashes, off };
}

/** Run a spec's grid directly for `steps` steps after its prerun. */
function grid(spec: CellularSpec, cols: number, rows: number, steps = 0) {
  const rnd = seeded(spec.seed);
  let g = spec.init(cols, rows, rnd);
  for (let i = 0; i < spec.prerun + steps; i++) g = spec.step(g, cols, rows, rnd);
  return { g, rnd };
}

describe('seeded', () => {
  it('repeats for the same seed, stays in [0, 1) and differs across seeds', () => {
    const a = seeded(7);
    const b = seeded(7);
    const c = seeded(8);
    const xs = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(c()).not.toBe(xs[0]);
  });
});

describe('mooreCount', () => {
  it('counts the eight neighbours, wrapping at the edges', () => {
    const g = new Uint8Array(9).fill(1);
    expect(mooreCount(g, 3, 3, 0, 0, 1)).toBe(8);
    const one = new Uint8Array(16);
    one[15] = 1; // bottom-right corner is the top-left's diagonal neighbour
    expect(mooreCount(one, 4, 4, 0, 0, 1)).toBe(1);
    expect(mooreCount(one, 4, 4, 1, 1, 1)).toBe(0);
  });
});

describe.each(SPECS)('%s', (id, spec) => {
  it('is registered as a drawer', () => {
    expect(drawerFor(id as never)).toBeTypeOf('function');
  });

  it('fills its whole box from the first frame', () => {
    const colours = fixtureColours('motir', 'light');
    const { ops, hashes, off } = run(id, colours);
    expect(ops).toContainEqual(['fillRect', 0, 0, W, H]);
    const draw = ops.find((op) => op[0] === 'drawImage')!;
    const cs = spec.cell(W);
    expect(draw).toEqual(['drawImage', 0, 0, Math.ceil(W / cs) * cs, Math.ceil(H / cs) * cs]);
    expect(draw[3] as number).toBeGreaterThanOrEqual(W);
    expect(draw[4] as number).toBeGreaterThanOrEqual(H);
    expect(ops).toContainEqual(['=imageSmoothingEnabled', false]);
    expect(hashes).toHaveLength(1);
    expect(off.made[0]!.ops[0]).toEqual(['createImageData', Math.ceil(W / cs), Math.ceil(H / cs)]);
  });

  it('opens already formed: the still frame shows more than the background', () => {
    const cols = 80;
    const rows = 50;
    const { g } = grid(spec, cols, rows);
    const colours = fixtureColours('motir', 'dark');
    const pal = spec.colours(colours);
    const buf = new Uint32Array(cols * rows);
    spec.paint(g, buf, cols, rows, pal);
    const bg = packRgb(colours.bg);
    const lit = buf.filter((v) => v !== bg).length;
    expect(lit / buf.length).toBeGreaterThan(0.01);
    expect(new Set(buf).size).toBeGreaterThan(1);
  });

  it('keeps moving without emptying out', () => {
    const cols = 80;
    const rows = 50;
    const start = grid(spec, cols, rows);
    const rnd = start.rnd;
    let g = start.g;
    for (let i = 0; i < 300; i++) {
      const before = g.slice();
      g = spec.step(g, cols, rows, rnd);
      expect(g).not.toEqual(before);
    }
    // Never all one state: neither empty nor saturated.
    expect(new Set(g).size).toBeGreaterThan(1);
  });

  it('draws the same frame under every style for the same palette and mode', () => {
    // A small box: the grid is the same work under every style, so size adds nothing here.
    const small: [number, number] = [120, 80];
    for (const { colours } of PALETTE_MODES.slice(0, 2)) {
      const reference = run(id, colours, STYLE_IDS[0]!, [0, 0.5], small);
      for (const style of STYLE_IDS) {
        const r = run(id, colours, style, [0, 0.5], small);
        expect(r.ops).toEqual(reference.ops);
        expect(r.hashes).toEqual(reference.hashes);
      }
    }
  });

  it('recolours with palette and with mode', () => {
    const light = run(id, fixtureColours('motir', 'light')).hashes;
    expect(run(id, fixtureColours('motir', 'dark')).hashes).not.toEqual(light);
    expect(run(id, fixtureColours('cobalt', 'light')).hashes).not.toEqual(light);
  });

  it('two instances of the same size show the same frame', () => {
    const colours = fixtureColours('amber', 'light');
    expect(run(id, colours, 'swiss-minimal-flat', [0, 1]).hashes).toEqual(
      run(id, colours, 'swiss-minimal-flat', [0, 1]).hashes,
    );
  });

  it('moves over time, catching up at most three steps per frame', () => {
    const colours = fixtureColours('motir', 'light');
    const { hashes } = run(id, colours, 'warm-editorial', [0, 1]);
    expect(hashes[1]).not.toBe(hashes[0]);
    // A long stall advances exactly as far as three steps would.
    const stalled = run(id, colours, 'warm-editorial', [0, 60]).hashes[1];
    const three = run(id, colours, 'warm-editorial', [0, spec.interval * 3 + 1e-9]).hashes[1];
    expect(stalled).toBe(three);
  });
});

describe('cellular drawer', () => {
  it('keeps its grid across a same-size resize and rebuilds it on a new size', () => {
    const colours = fixtureColours('motir', 'light');
    const drawer = cellular(CYCLIC)();
    const off = recordingCanvasFactory();
    const { ctx } = recordingContext();
    const env = { colours, style: 'warm-editorial' as const, focus, createCanvas: off.create };
    drawer.resize(W, H);
    drawer.frame(ctx, 0, env);
    drawer.frame(ctx, 1, env);
    drawer.resize(W, H);
    drawer.frame(ctx, 1.1, env);
    expect(off.made).toHaveLength(1);
    drawer.resize(700, 300);
    drawer.frame(ctx, 2, env);
    expect(off.made).toHaveLength(2);
    // A box over 600 wide takes the bigger cell.
    expect(off.made[1]!.ops[0]).toEqual(['createImageData', 140, 60]);
  });

  it('draws only the page colour when no off-screen canvas can be made', () => {
    const drawer = cellular(BRIAN)();
    const { ctx, ops } = recordingContext();
    drawer.resize(W, H);
    drawer.frame(ctx, 0, {
      colours: fixtureColours('motir', 'light'),
      style: 'warm-editorial',
      focus,
      createCanvas: () => null,
    });
    expect(ops).toContainEqual(['fillRect', 0, 0, W, H]);
    expect(ops.some((op) => op[0] === 'drawImage')).toBe(false);
  });

  it('Brian reseeds instead of dying out', () => {
    const empty = new Uint8Array(40 * 30);
    const next = BRIAN.step(empty, 40, 30, seeded(1));
    expect(next.some((v) => v === 1)).toBe(true);
  });

  it("Brian's Brain and Day & Night colour their cells from the decision token, not the CTA fill", () => {
    const colours = fixtureColours('motir', 'light');
    const inkAccent = { ...colours, accent: colours.ink };
    expect(BRIAN.colours(inkAccent)).toEqual(BRIAN.colours(colours));
    expect(DAY_NIGHT.colours(inkAccent)).toEqual(DAY_NIGHT.colours(colours));
    const otherDecision = { ...colours, decision: colours.hues[0] };
    expect(BRIAN.colours(otherDecision)).not.toEqual(BRIAN.colours(colours));
    expect(DAY_NIGHT.colours(otherDecision)).not.toEqual(DAY_NIGHT.colours(colours));
  });

  it('Cyclic cycles through all of its states', () => {
    const { g } = grid(CYCLIC, 60, 40);
    expect(new Set(g).size).toBe(CYCLIC_STATES);
  });

  it('Rule 110 colours its cells by column across the width', () => {
    const colours = fixtureColours('motir', 'light');
    const pal = RULE110.colours(colours);
    const g = new Uint8Array(64).fill(1);
    const buf = new Uint32Array(64);
    RULE110.paint(g, buf, 64, 1, pal);
    expect(buf[0]).toBe(pal[1]);
    expect(buf[63]).toBe(pal[pal.length - 1]);
    g[5] = 0;
    RULE110.paint(g, buf, 64, 1, pal);
    expect(buf[5]).toBe(packRgb(colours.bg));
  });
});
