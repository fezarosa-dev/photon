import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLdpc } from '../src/ldpc.ts';
import { rng } from '../src/frame.ts';

const r = rng(1234);
const unif = () => (r() + 0.5) / 4294967296;
const randBits = (k: number) => Uint8Array.from({ length: k }, () => r() & 1);

function bsc(cw: Uint8Array, p: number) {
  const l = Math.log((1 - p) / p);
  const llr = new Float32Array(cw.length);
  for (let i = 0; i < cw.length; i++) llr[i] = cw[i] ^ (unif() < p ? 1 : 0) ? -l : l;
  return llr;
}

function successRate(n: number, k: number, p: number, trials: number) {
  const c = makeLdpc(n, k, 7);
  let ok = 0;
  for (let t = 0; t < trials; t++) {
    const info = randBits(k);
    const d = c.decode(bsc(c.encode(info), p));
    if (d.ok && d.bits.every((b, i) => b === info[i])) ok++;
  }
  return ok / trials;
}

test('codifica sistemático e LLR perfeito decodifica em <=1 iteração', () => {
  for (const [n, k] of [[1000, 800], [4000, 2000], [12000, 9000]]) {
    const c = makeLdpc(n, k);
    const info = randBits(k);
    const cw = c.encode(info);
    assert.equal(cw.length, n);
    assert.deepEqual(cw.subarray(0, k), info);
    const llr = Float32Array.from(cw, (b) => (b ? -10 : 10));
    const d = c.decode(llr);
    assert.ok(d.ok && d.iters <= 1);
    assert.deepEqual(d.bits, info);
    // LLR infinito também é aceito (saturado)
    assert.ok(c.decode(Float32Array.from(cw, (b) => (b ? -Infinity : Infinity))).ok);
  }
});

test('determinístico em (n,k,seed)', () => {
  const a = makeLdpc(2000, 1600, 5), b = makeLdpc(2000, 1600, 5), c = makeLdpc(2000, 1600, 6);
  const info = randBits(1600);
  assert.deepEqual(a.encode(info), b.encode(info));
  assert.notDeepEqual(a.encode(info), c.encode(info));
});

test('BSC: taxa 3/4 p=0.025 e taxa 1/2 p=0.07 >=95%', () => {
  assert.ok(successRate(12000, 9000, 0.025, 40) >= 0.95);
  assert.ok(successRate(12000, 6000, 0.07, 40) >= 0.95);
});

test('falha reporta ok=false e nunca ok com paridade violada', () => {
  const c = makeLdpc(4000, 3000);
  const info = randBits(3000);
  const d = c.decode(bsc(c.encode(info), 0.2));
  assert.equal(d.ok, false);
  assert.equal(d.iters, 30);
});

test('AWGN: soft supera hard', () => {
  const n = 12000, k = 6000, c = makeLdpc(n, k, 7);
  const sigma = 0.8; // BPSK, Es=1
  let soft = 0, hard = 0;
  for (let t = 0; t < 10; t++) {
    const info = randBits(k), cw = c.encode(info);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const g = Math.sqrt(-2 * Math.log(unif())) * Math.cos(2 * Math.PI * unif());
      y[i] = (cw[i] ? -1 : 1) + sigma * g;
    }
    const ls = y.map((v) => (2 * v) / (sigma * sigma));
    const lh = y.map((v) => (v < 0 ? -2.2 : 2.2));
    if (c.decode(ls).ok) soft++;
    if (c.decode(lh).ok) hard++;
  }
  console.log(`AWGN sigma=${sigma}: soft ${soft}/10 hard ${hard}/10`);
  assert.ok(soft >= 9 && hard < soft);
});

test('desempenho', () => {
  let t0 = performance.now();
  makeLdpc(16000, 12000, 3);
  const mk = performance.now() - t0;
  const c = makeLdpc(12000, 9000, 7);
  let sum = 0, worst = 0;
  const N = 30;
  for (let t = 0; t < N; t++) {
    const llr = bsc(c.encode(randBits(9000)), 0.02);
    t0 = performance.now();
    c.decode(llr);
    const ms = performance.now() - t0;
    sum += ms; worst = Math.max(worst, ms);
  }
  console.log(`make n=16000: ${mk.toFixed(0)} ms; decode avg ${(sum / N).toFixed(1)} ms worst ${worst.toFixed(1)} ms`);
  assert.ok(mk < 1000);
});

// varredura de limiar 95% (só loga): LDPC_SWEEP=1 node --test test/ldpc.test.ts
test('varredura p95 por taxa', { skip: !process.env.LDPC_SWEEP }, () => {
  for (const R of [0.5, 0.67, 0.75, 0.83, 0.9]) {
    const k = Math.round((12000 * R) / 8) * 8;
    let lo = 0.005, hi = 0.12;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      if (successRate(12000, k, mid, 20) >= 0.95) lo = mid; else hi = mid;
    }
    console.log(`taxa ${R}: p95 ~ ${lo.toFixed(4)}`);
  }
});
