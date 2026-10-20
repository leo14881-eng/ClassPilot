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

test('speech detector: soft syllables inside a sentence are not silence; a real pause is', async () => {
  const { Vad } = await import('../src/client/voice');
  const vad = new Vad();
  // 0.6 s room noise, then speech that dips to soft syllables (0.04–0.09), then a real pause.
  const room = Array(10).fill(0.002);
  const speech = [0.13, 0.26, 0.28, 0.25, 0.055, 0.036, 0.29, 0.31, 0.3, 0.29, 0.19, 0.11, 0.059, 0.089, 0.097, 0.25, 0.126, 0.055, 0.046, 0.125, 0.29, 0.31];
  const pause = Array(8).fill(0.002);
  const out = [...room, ...speech, ...pause].map((l) => vad.loud(l));
  assert.ok(out.slice(0, 10).every((x) => !x), 'room noise is quiet');
  assert.ok(out.slice(10, 10 + speech.length).every((x) => x), 'the whole sentence counts as speech');
  assert.ok(out.slice(-6).every((x) => !x), 'the pause after it is quiet');
  // A noisy classroom (background 0.02) still separates speech.
  const v2 = new Vad();
  const noisy = [...Array(30).fill(0.02), 0.2, 0.25, 0.07, 0.22, ...Array(10).fill(0.02)].map((l) => v2.loud(l));
  assert.ok(noisy.slice(0, 30).every((x) => !x));
  assert.ok(noisy.slice(30, 34).every((x) => x));
  assert.ok(noisy.slice(-5).every((x) => !x));
});

test('class segmenter: a pause before a 5 s sentence does not cut the sentence; a long pause ends it', async () => {
  const { SegmentListener } = await import('../src/client/voice');
  // Drive the segmenter's frame handler directly with synthetic 64 ms frames.
  const segments: number[] = [];
  const listener = new SegmentListener({} as MediaStream, { onSegment: (wav) => segments.push(wav.size) });
  // Replace the audio tap: capture the frame callback instead of opening audio.
  const anyL = listener as unknown as { start(): void };
  let onFrame: ((f: Float32Array) => void) | null = null;
  (globalThis as unknown as { __captureTap: (cb: (f: Float32Array) => void) => void }).__captureTap = (cb) => (onFrame = cb);
  anyL.start();
  assert.ok(onFrame, 'test hook captured the frame handler');
  const frame = (amp: number) => Float32Array.from({ length: 1024 }, (_, i) => amp * Math.sin(i / 3));
  const feed = (amp: number, ms: number) => {
    for (let t = 0; t < ms; t += 64) onFrame!(frame(amp));
  };
  feed(0.001, 1500); // gap after the previous sentence
  // 5 s sentence with short (0.3 s) dips between words
  for (let w = 0; w < 10; w++) {
    feed(0.3, 200);
    feed(0.05, 300);
  }
  assert.equal(segments.length, 0, 'not cut while speaking');
  feed(0.001, 1200); // real pause
  assert.equal(segments.length, 1, 'one segment for the whole sentence');
});
