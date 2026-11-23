// Worker de leitura no Node: ambiente de worker simulado, mesma porta de mensagens que o navegador usa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FH, FW, TYPE_DATA, render, rng, type Header } from '../src/frame.ts';
import { makePlan, makeReceiver, makeSender, rxKey } from '../src/transfer.ts';
import type { Done, Job } from '../src/worker.ts';
import { TILT, camera } from './sim.ts';

const sent: Done[] = [];
(globalThis as unknown as { self: unknown }).self = { postMessage: (d: Done) => sent.push(d) };
await import('../src/worker.ts');
const handle = (job: Job) => {
  (globalThis as unknown as { self: { onmessage: (e: { data: Job }) => void } }).self.onmessage({ data: job });
  return sent.pop()!;
};

const LEVEL = 10, RATE = 0.75;
const r = rng(4), payload = Uint8Array.from({ length: 30_000 }, () => r() & 255);
const plan = makePlan(LEVEL, RATE), tx = makeSender(payload, plan), px = new Uint32Array(FW * FH);
const hdr = (frame: number): Header => ({ type: TYPE_DATA, config: LEVEL, fps: 20, session: 9, frame, size: payload.length,
  sha: new Uint8Array(32), name: 'x', rate: RATE, flags: 0, plen: payload.length });
const shot = (f: number) => { render(px, hdr(f), tx.symbols(f)); return camera(px, TILT); };

test('worker lê o quadro, corrige o LDPC e o receptor completa o arquivo', () => {
  const rx = makeReceiver(payload.length, plan);
  for (let f = 0; f < 6 && !rx.done; f++) {
    const d = handle({ seq: f, key: '', skip: [], skipAll: false, pixels: shot(f) });
    assert.equal(d.res.status, 'ok');
    assert.equal(d.words!.ok, plan.m);
    assert.equal((d.res as { llr?: unknown }).llr, undefined); // bits suaves não voltam (só os pacotes)
    rx.addWords(d.words!);
  }
  assert.ok(rx.done);
  assert.deepEqual(rx.result(), payload);
});

test('quadro já aproveitado não é decodificado de novo; outra recepção é', () => {
  const key = rxKey(hdr(0)), img = shot(3);
  assert.equal(handle({ seq: 1, key, skip: [3], skipAll: false, pixels: img }).words, undefined);
  assert.equal(handle({ seq: 2, key, skip: [], skipAll: true, pixels: img }).words, undefined);
  assert.equal(handle({ seq: 3, key: 'outra', skip: [3], skipAll: true, pixels: img }).words!.ok, plan.m);
});
