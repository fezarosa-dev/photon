// Ponta a ponta: arquivo → quadros de dados → câmera simulada → leitura → LDPC → fountain → arquivo idêntico.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FH, FW, TYPE_DATA, decodeFrame, render, rng, type Header } from '../src/frame.ts';
import { inflate, makePlan, makeReceiver, makeSender, maybeDeflate } from '../src/transfer.ts';
import { TILT, camera } from './sim.ts';

const LEVEL = 7; // nível 8: célula 6 px, 8 cores
const RATE = 0.75;

function transmit(payload: Uint8Array, drop: Set<number>, maxFrames: number) {
  const plan = makePlan(LEVEL, RATE), tx = makeSender(payload, plan), rx = makeReceiver(payload.length, plan);
  const px = new Uint32Array(FW * FH);
  const h = (frame: number): Header => ({
    type: TYPE_DATA, config: LEVEL, fps: 20, session: 7, frame, size: payload.length, sha: new Uint8Array(32),
    name: 'x.bin', rate: RATE, flags: 0, plen: payload.length,
  });
  let frames = 0;
  for (let f = 0; f < maxFrames && !rx.done; f++) {
    if (drop.has(f)) continue; // imagem perdida (borrão, misturada…)
    render(px, h(f), tx.symbols(f));
    const res = decodeFrame(camera(px, TILT));
    assert.equal(res.status, 'ok');
    assert.equal(res.header!.rate, RATE);
    assert.equal(res.header!.plen, payload.length);
    const before = rx.progress;
    rx.add(res.llr!);
    assert.ok(rx.progress > before, `progresso parado em ${rx.progress}`); // sobe a cada imagem, não só no fim
    frames++;
  }
  return { rx, plan, frames };
}

test('arquivo atravessa a câmera simulada idêntico, mesmo perdendo imagens', () => {
  const r = rng(99), payload = Uint8Array.from({ length: 40_000 }, () => r() & 255); // aleatório: incompressível
  const { rx, plan, frames } = transmit(payload, new Set([1, 2]), 12);
  assert.ok(rx.done, `não completou: ${JSON.stringify(rx.stats)}`);
  assert.deepEqual(rx.result(), payload);
  const s = rx.stats;
  assert.equal(s.crcFail, 0);
  console.log(`plano: ${plan.m} palavras/quadro, n=${plan.n}, k=${plan.k}, ${plan.packetSize} B/pacote · ${frames} quadros · palavras ok ${s.wordsOk}/${s.words} · ${(plan.m * plan.packetSize / 1024).toFixed(1)} KB/imagem`);
});

test('compressão só quando compensa, e volta idêntica', async () => {
  const text = new TextEncoder().encode('linha de planilha;123;456;texto repetido\n'.repeat(2000));
  const c = await maybeDeflate(text);
  assert.ok(c.deflated && c.bytes.length < text.length / 5);
  assert.deepEqual(await inflate(c.bytes), text);
  const r = rng(3), noise = Uint8Array.from({ length: 10_000 }, () => r() & 255);
  assert.equal((await maybeDeflate(noise)).deflated, false);
});

test('paridade escolhida pelo erro medido (com folga)', async () => {
  const { pickRate } = await import('../src/transfer.ts');
  assert.equal(pickRate(0, 3), 0.9);
  assert.equal(pickRate(0.031, 3), 0.83); // nível 8 a 0,8× na varredura: ~1% de erro de bit
  assert.equal(pickRate(0.10, 3), 0.5);
  assert.equal(pickRate(0.40, 3), 0);     // nem com 50% de paridade
});
