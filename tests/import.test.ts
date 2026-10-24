// Splitting a whole-class recording (iPhone Voice Memos .m4a, .mp3, .wav) into pieces without decoding it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { splitRecording } from '../src/server/audiofile';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name));

test('m4a (Voice Memos): split into standard m4a pieces that cover the whole recording', () => {
  const r = splitRecording(fixture('voice-20s.m4a'), 'audio/x-m4a', 5);
  assert.ok(Math.abs(r.durationSec - 20) < 0.2, String(r.durationSec));
  assert.equal(r.parts.length, 4);
  assert.equal(r.recordedAt, Date.parse('2026-10-24T07:00:00Z'));
  let sum = 0;
  for (const [i, p] of r.parts.entries()) {
    assert.equal(p.mime, 'audio/mp4');
    assert.equal(p.data.toString('latin1', 4, 8), 'ftyp');
    // Each piece is itself a valid m4a: it parses back as one piece of about 5 seconds.
    const again = splitRecording(p.data, p.mime, 300);
    assert.equal(again.parts.length, 1);
    assert.ok(Math.abs(p.startSec - i * 5) < 0.2);
    sum += again.durationSec;
  }
  assert.ok(Math.abs(sum - r.durationSec) < 0.01);
});

test('m4a cut short (phone ran out of space): keeps every whole sample instead of failing', () => {
  const full = fixture('voice-20s.m4a');
  const r = splitRecording(full.subarray(0, Math.floor(full.length * 0.6)), '', 5);
  assert.ok(r.durationSec > 8 && r.durationSec < 14, String(r.durationSec));
});

test('mp3: split on frame boundaries, the whole-file length header is not copied into the first piece', () => {
  const r = splitRecording(fixture('voice-20s.mp3'), 'audio/mpeg', 5);
  assert.equal(r.parts.length, 4); // a tiny tail stays with the last piece
  assert.ok(Math.abs(r.durationSec - 20) < 0.2);
  assert.doesNotMatch(r.parts[0].data.toString('latin1', 0, 64), /Xing|Info/);
  for (const p of r.parts) assert.equal(p.data[0], 0xff);
});

test('wav: split into pieces with their own headers, each under the provider size limit', () => {
  const rate = 48000;
  const pcm = Buffer.alloc(rate * 2 * 2 * 200); // 200 s of 48 kHz stereo 16-bit
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(2, 2);
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * 4, 8);
  fmt.writeUInt16LE(4, 12);
  fmt.writeUInt16LE(16, 14);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + 24 + 8 + pcm.length, 4);
  const size = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const wav = Buffer.concat([head, Buffer.from('WAVEfmt ', 'latin1'), size(16), fmt, Buffer.from('data', 'latin1'), size(pcm.length), pcm]);
  const r = splitRecording(wav, 'audio/wav');
  assert.ok(Math.abs(r.durationSec - 200) < 0.01);
  assert.ok(r.parts.length >= 3);
  for (const p of r.parts) {
    assert.ok(p.data.length < 16_000_000);
    assert.equal(p.data.toString('latin1', 0, 4), 'RIFF');
    assert.equal(p.data.readUInt32LE(4), p.data.length - 8);
  }
});

test('unknown formats: small files go up whole, big ones are refused with a clear message', () => {
  assert.equal(splitRecording(Buffer.from('not audio at all'), 'audio/ogg').parts.length, 1);
  assert.throws(() => splitRecording(Buffer.alloc(30_000_000, 1), 'audio/ogg'), /语音备忘录/);
});
