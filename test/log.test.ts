// Planilha: aproveitamento = imagens distintas lidas ÷ imagens mostradas, por bloco contínuo de mesmo (fps, nível).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLog } from '../src/log.ts';
import type { Decoded, Header } from '../src/frame.ts';

const hdr = (frame: number, fps: number, config: number): Header =>
  ({ type: 2, config, fps, session: 1, frame, size: 0, sha: new Uint8Array(32), name: 'teste' });
const ok = (frame: number, fps = 30, config = 6): Decoded =>
  ({ status: 'ok', anchors: [], header: hdr(frame, fps, config), errors: 5, cells: 100 });

async function summary(log: ReturnType<typeof createLog>) {
  const text = await log.files(['meta'])[0].text();
  const [head, ...rows] = text.split('\n').filter((l) => l && !l.startsWith('#'));
  const cols = head.split(',');
  return rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [cols[i], v])));
}

test('imagens puladas e duplicadas entram certo no aproveitamento', async () => {
  const log = createLog();
  for (let f = 0; f < 40; f += 2) { log.add(ok(f), 0.84, 50, 45); log.add(ok(f), 0.84, 50, 45); } // 20 distintas, cada uma 2×
  const [r] = await summary(log);
  assert.equal(r.leituras, '40');
  assert.equal(r.distintas, '20');
  assert.equal(r.mostradas, '39');           // de 0 a 38
  assert.equal(r.aproveitamento_pct, '51.3');
  assert.equal(r.erro_pct, '5.00');
  assert.equal(r.escala, '0.8');
});

test('envio periódico não fecha o bloco: mesma conta antes e depois', async () => {
  const log = createLog();
  for (let f = 0; f < 10; f++) log.add(ok(f), 0.5, 50, 45);
  await summary(log);                          // envio no meio do bloco
  for (let f = 12; f < 20; f += 3) log.add(ok(f), 0.5, 50, 45); // 10 e 11 perdidas logo após o envio
  const [r] = await summary(log);
  assert.equal(r.distintas, '13');
  assert.equal(r.mostradas, '19');             // de 0 a 18, um bloco só (fechar no envio daria 10 + 7 = 17)
});

test('troca de nível/fps separa linhas; misturado conta à parte', async () => {
  const log = createLog();
  log.add(ok(0, 30, 6), 0.7, 50, 45);
  log.add(ok(1, 20, 6), 0.7, 50, 45);
  log.add({ ...ok(2, 20, 6), status: 'misturado' }, 0.7, 50, 45);
  const rows = await summary(log);
  assert.deepEqual(rows.map((r) => [r.fps_emissor, r.leituras, r.misturados]), [['20', '1', '1'], ['30', '1', '0']]);
});

test('cobertura: instrução e porcentagem guiam até 100%', () => {
  const log = createLog();
  let f = 0;
  const fill = (scale: number) => {
    for (const fps of [30, 20, 15]) for (let config = 0; config < 12; config++) for (let k = 0; k < 5; k++) log.add(ok(f++, fps, config), scale, 50, 45);
  };
  assert.deepEqual(log.coverage(0), { progress: 0, action: 'enquadre' });
  assert.equal(log.coverage(0.6).action, 'parado');   // faixa atual ainda vazia
  fill(0.6);
  assert.deepEqual(log.coverage(0.6), { progress: 25, action: 'afaste' }); // empate 0.5/0.7: vai para a menor escala
  assert.equal(log.coverage(0.4).action, 'aproxime'); // longe demais: a faixa que falta mais perto é 0.5
  assert.equal(log.coverage(0.9).action, 'afaste');   // perto demais: a faixa que falta mais perto é 0.8
  assert.equal(log.coverage(0.75).action, 'parado');  // 0.75 → faixa 0.8, que ainda falta
  fill(0.7); fill(0.8);
  assert.deepEqual(log.coverage(0.8), { progress: 75, action: 'afaste' });
  fill(0.5);
  assert.deepEqual(log.coverage(0.5), { progress: 100, action: 'pronto' });
});
