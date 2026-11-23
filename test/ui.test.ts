// Formatação de tamanhos: a unidade acompanha o tamanho do arquivo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes } from '../src/ui.ts';

test('unidade conforme o tamanho (B, KB, MB, GB), vírgula decimal', () => {
  assert.equal(formatBytes(812), '812 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(150 * 1024), '150 KB');
  assert.equal(formatBytes(2_071_487), '2 MB');
  assert.equal(formatBytes(9_968_098), '9,5 MB');
  assert.equal(formatBytes(3.2 * 1024 ** 3), '3,2 GB');
});
