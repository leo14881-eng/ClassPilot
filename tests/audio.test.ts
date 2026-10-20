import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandMulawWav } from '../src/server/ai';
import { mulaw } from '../src/client/voice';

test('μ-law: phone encoding + server expansion round-trips within μ-law precision', () => {
  const samples = [0, 0.001, -0.001, 0.01, -0.05, 0.2, -0.5, 0.9, -1, 1];
  const n = samples.length;
  const wav = Buffer.alloc(44 + n);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + n, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(7, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(12000, 24);
  wav.writeUInt32LE(12000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(n, 40);
  samples.forEach((x, i) => wav.writeUInt8(mulaw(x), 44 + i));
  const pcm = expandMulawWav(wav);
  assert.equal(pcm.readUInt16LE(20), 1, 'PCM');
  assert.equal(pcm.readUInt16LE(34), 16, '16-bit');
  assert.equal(pcm.readUInt32LE(24), 12000, 'same rate');
  samples.forEach((x, i) => {
    const y = pcm.readInt16LE(44 + i * 2) / 32768;
    assert.ok(Math.abs(y - x) <= Math.max(0.002, Math.abs(x) * 0.07), `${x} → ${y}`);
  });
  // Plain PCM WAV and other formats pass through unchanged.
  assert.equal(expandMulawWav(pcm), pcm);
  const m4a = Buffer.from('not a wav file at all, just bytes ......................................');
  assert.equal(expandMulawWav(m4a), m4a);
});
