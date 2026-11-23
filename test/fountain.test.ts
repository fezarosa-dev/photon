import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ltEncoder, ltDecoder } from '../src/fountain.ts';
import { rng } from '../src/frame.ts';

const rand = (s: number) => { const r = rng(s); return () => r() / 4294967296; };
const mkdata = (n: number, s: number) => { const r = rng(s); const d = new Uint8Array(n); for (let i = 0; i < n; i++) d[i] = r() >>> 24; return d; };

// recebe k..: ids com 30% de perda, embaralhados e duplicados
for (const k of [1, 7, 1000, 10000]) {
  test(`roundtrip k=${k} perda 30% + ordem + duplicatas`, () => {
    const ps = k >= 10000 ? 16 : 37;
    const data = mkdata(k * ps - (k > 1 ? 5 : 0), k);
    const enc = ltEncoder(data, ps);
    assert.equal(enc.k, k);
    const R = rand(k + 1);
    const ids: number[] = [];
    for (let i = 0; i < Math.ceil(k * 3) + 50; i++) if (R() > 0.3) { ids.push(i); if (R() < 0.2) ids.push(i); }
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    const dec = ltDecoder(k, ps);
    for (const id of ids) if (dec.add(id, enc.packet(id))) break;
    assert.ok(dec.done);
    assert.equal(dec.recovered, k);
    assert.deepEqual(dec.result().subarray(0, data.length), data);
    assert.equal(dec.add(0, enc.packet(0)), true); // duplicata após concluir
  });
}

test('determinismo e pacote sistemático', () => {
  const data = mkdata(1000, 5);
  const a = ltEncoder(data, 10), b = ltEncoder(data, 10);
  assert.deepEqual(a.packet(500), b.packet(500));
  assert.deepEqual(a.packet(3), data.subarray(30, 40));
});

function overhead(k: number, trials: number, loss: boolean) {
  const ps = 8, data = mkdata(k * ps, 9), enc = ltEncoder(data, ps);
  let tot = 0;
  for (let t = 0; t < trials; t++) {
    const R = rand(1000 + t), dec = ltDecoder(k, ps);
    let id = loss ? 0 : k + t * 1_000_000;
    while (!dec.done) { if (!loss || R() > 0.3) dec.add(id, enc.packet(id)); id++; }
    assert.deepEqual(dec.result(), data);
    tot += dec.received / k;
  }
  return tot / trials;
}

test('overhead', () => {
  const r1 = overhead(1000, 20, false), r2 = overhead(10000, 20, false), r3 = overhead(10000, 20, true);
  console.log(`overhead k1000_repair=${r1.toFixed(4)} k10000_repair=${r2.toFixed(4)} k10000_loss30=${r3.toFixed(4)}`);
  assert.ok(r1 <= 1.1 && r2 <= 1.1 && r3 <= 1.5); // r3: sistemático+perda é pior (peeling sobre fonte ralo)
});

test('desempenho k=10000 ps=1000', () => {
  const k = 10000, ps = 1000, data = mkdata(k * ps, 3);
  const t0 = performance.now();
  const enc = ltEncoder(data, ps);
  for (let i = 0; i < 11000; i++) enc.packet(i);
  const t1 = performance.now();
  // decodifica fluxo sistemático+reparo com 30% de perda, gerando reparos até completar
  const dec = ltDecoder(k, ps), R = rand(7);
  for (let id = 0; !dec.done; id++) if (R() > 0.3) dec.add(id, enc.packet(id));
  const t2 = performance.now();
  assert.deepEqual(dec.result(), data);
  console.log(`perf encode11000=${(t1 - t0).toFixed(0)}ms decode(+geração)=${(t2 - t1).toFixed(0)}ms ovh=${(dec.received / k).toFixed(3)}`);
  assert.ok(t2 - t0 < 6000);
});
