// Split a whole-class recording (iPhone Voice Memos .m4a, or .mp3 / .wav from other recorders) into
// 5-minute pieces without decoding it, so each piece fits the speech-to-text size and time limits.
// iPhone web pages cannot record while the screen is locked or another app is in front, so a full class is
// recorded with Voice Memos and imported afterwards. No dependencies: MP4 boxes, MP3 frames and WAV chunks
// are read directly; .m4a pieces are written as small standard .m4a files that every provider accepts.

export interface RecordingPart {
  data: Buffer;
  mime: string;
  /** Seconds from the start of the recording. */
  startSec: number;
}

export interface SplitRecording {
  parts: RecordingPart[];
  durationSec: number;
  /** Recording time stored in the file (Voice Memos writes it), if any. */
  recordedAt?: number;
}

const PART_SEC = 300;
const WHOLE_LIMIT = 24_000_000;

export function splitRecording(buf: Buffer, mime = '', partSec = PART_SEC): SplitRecording {
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') return splitMp4(buf, partSec);
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') return splitWav(buf, partSec);
  if (isMp3(buf)) return splitMp3(buf, partSec);
  if (buf.length <= WHOLE_LIMIT) return { parts: [{ data: buf, mime: mime || 'audio/mp4', startSec: 0 }], durationSec: 0 };
  throw new Error('这个录音格式不支持，请用 iPhone「语音备忘录」录音（.m4a），或 .mp3 / .wav');
}

// ---------- MP4 / M4A ----------

interface Box {
  type: string;
  start: number; // header start
  body: number; // payload start
  end: number;
}

function boxes(buf: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let p = from;
  while (p + 8 <= to) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let body = p + 8;
    if (size === 1) {
      if (p + 16 > to) break;
      size = Number(buf.readBigUInt64BE(p + 8));
      body = p + 16;
    } else if (size === 0) {
      size = to - p;
    }
    if (size < body - p || p + size > to) break; // truncated file: keep what was read
    out.push({ type, start: p, body, end: p + size });
    p += size;
  }
  return out;
}

const child = (buf: Buffer, b: Box, type: string) => boxes(buf, b.body, b.end).find((x) => x.type === type);
function path(buf: Buffer, b: Box | undefined, ...types: string[]): Box | undefined {
  for (const t of types) b = b && child(buf, b, t);
  return b;
}

interface Sample {
  offset: number;
  size: number;
  delta: number;
}

function splitMp4(buf: Buffer, partSec: number): SplitRecording {
  const top = boxes(buf, 0, buf.length);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) throw new Error('录音文件不完整（可能还没录完或没保存好），请重新导出');
  const trak = boxes(buf, moov.body, moov.end)
    .filter((b) => b.type === 'trak')
    .find((t) => {
      const hdlr = path(buf, t, 'mdia', 'hdlr');
      return hdlr && buf.toString('latin1', hdlr.body + 8, hdlr.body + 12) === 'soun';
    });
  const mdhd = trak && path(buf, trak, 'mdia', 'mdhd');
  const stbl = trak && path(buf, trak, 'mdia', 'minf', 'stbl');
  if (!trak || !mdhd || !stbl) throw new Error('录音文件里没有找到声音');
  const v = buf[mdhd.body];
  const timescale = v === 1 ? buf.readUInt32BE(mdhd.body + 20) : buf.readUInt32BE(mdhd.body + 12);
  const created = v === 1 ? Number(buf.readBigUInt64BE(mdhd.body + 4)) : buf.readUInt32BE(mdhd.body + 4);
  const mvhd = child(buf, moov, 'mvhd');
  const movieCreated = mvhd ? (buf[mvhd.body] === 1 ? Number(buf.readBigUInt64BE(mvhd.body + 4)) : buf.readUInt32BE(mvhd.body + 4)) : 0;
  const get = (t: string) => child(buf, stbl, t);
  const stsd = get('stsd');
  const stts = get('stts');
  const stsc = get('stsc');
  const stsz = get('stsz');
  const stco = get('stco') ?? get('co64');
  if (!stsd || !stts || !stsc || !stsz || !stco || !timescale) {
    // Fragmented MP4 (no sample tables): small files go up whole.
    if (buf.length <= WHOLE_LIMIT) return { parts: [{ data: buf, mime: 'audio/mp4', startSec: 0 }], durationSec: 0 };
    throw new Error('这个录音文件的格式拆不开，请用 iPhone「语音备忘录」录音再导入');
  }

  // Sample sizes.
  const fixed = buf.readUInt32BE(stsz.body + 4);
  const count = buf.readUInt32BE(stsz.body + 8);
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) sizes.push(fixed || buf.readUInt32BE(stsz.body + 12 + i * 4));
  // Durations.
  const deltas: number[] = [];
  const nStts = buf.readUInt32BE(stts.body + 4);
  for (let i = 0; i < nStts && deltas.length < count; i++) {
    const n = buf.readUInt32BE(stts.body + 8 + i * 8);
    const d = buf.readUInt32BE(stts.body + 12 + i * 8);
    for (let k = 0; k < n && deltas.length < count; k++) deltas.push(d);
  }
  while (deltas.length < count) deltas.push(deltas[deltas.length - 1] ?? 1024);
  // Chunk offsets.
  const wide = stco.type === 'co64';
  const nChunks = buf.readUInt32BE(stco.body + 4);
  const chunkAt = (i: number) => (wide ? Number(buf.readBigUInt64BE(stco.body + 8 + i * 8)) : buf.readUInt32BE(stco.body + 8 + i * 4));
  // Samples per chunk.
  const nStsc = buf.readUInt32BE(stsc.body + 4);
  const runs = Array.from({ length: nStsc }, (_, i) => ({ first: buf.readUInt32BE(stsc.body + 8 + i * 12), per: buf.readUInt32BE(stsc.body + 12 + i * 12) }));
  const samples: Sample[] = [];
  let s = 0;
  for (let c = 0; c < nChunks && s < count; c++) {
    const run = [...runs].reverse().find((r) => r.first <= c + 1);
    let off = chunkAt(c);
    for (let k = 0; k < (run?.per ?? 1) && s < count; k++, s++) {
      if (off + sizes[s] > buf.length) break; // recording cut short: stop at the last whole sample
      samples.push({ offset: off, size: sizes[s], delta: deltas[s] });
      off += sizes[s];
    }
  }
  if (!samples.length) throw new Error('录音是空的');

  const stsdBox = buf.subarray(stsd.start, stsd.end);
  const parts: RecordingPart[] = [];
  const total = samples.reduce((a, x) => a + x.delta, 0);
  let t = 0;
  let from = 0;
  let partT = 0;
  for (let i = 0; i <= samples.length; i++) {
    // A short tail (under a fifth of a piece) stays with the piece before it.
    if (i === samples.length || (t - partT >= partSec * timescale && i > from && total - t >= partSec * timescale * 0.2)) {
      parts.push({ data: muxM4a(buf, samples.slice(from, i), timescale, stsdBox), mime: 'audio/mp4', startSec: partT / timescale });
      from = i;
      partT = t;
    }
    if (i < samples.length) t += samples[i].delta;
  }
  const at = movieCreated || created;
  // MP4 times count seconds from 1904-01-01.
  const recordedAt = at > 3_700_000_000 ? (at - 2_082_844_800) * 1000 : undefined;
  return { parts, durationSec: t / timescale, recordedAt };
}

function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

function u32(...n: number[]): Buffer {
  const b = Buffer.alloc(n.length * 4);
  n.forEach((x, i) => b.writeUInt32BE(x >>> 0, i * 4));
  return b;
}

const MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

/** A minimal standard .m4a holding the given AAC samples (one chunk, sample table copied from the source). */
function muxM4a(src: Buffer, samples: Sample[], timescale: number, stsd: Buffer): Buffer {
  const duration = samples.reduce((a, s) => a + s.delta, 0);
  const sttsRuns: [number, number][] = [];
  for (const s of samples) {
    const last = sttsRuns[sttsRuns.length - 1];
    if (last && last[1] === s.delta) last[0]++;
    else sttsRuns.push([1, s.delta]);
  }
  const build = (chunkOffset: number) => {
    const stbl = box(
      'stbl',
      stsd,
      box('stts', u32(0, sttsRuns.length, ...sttsRuns.flat())),
      box('stsc', u32(0, 1, 1, samples.length, 1)),
      box('stsz', u32(0, 0, samples.length, ...samples.map((s) => s.size))),
      box('stco', u32(0, 1, chunkOffset)),
    );
    const minf = box('minf', box('smhd', u32(0, 0)), box('dinf', box('dref', u32(0, 1), box('url ', u32(1)))), stbl);
    const hdlr = box('hdlr', u32(0, 0), Buffer.from('soun', 'latin1'), u32(0, 0, 0), Buffer.from('SoundHandler\0', 'latin1'));
    const mdhd = box('mdhd', u32(0, 0, 0, timescale, duration), Buffer.from([0x55, 0xc4, 0, 0]));
    const tkhd = box('tkhd', u32(3, 0, 0, 1, 0, duration, 0, 0), Buffer.from([0, 0, 0, 0, 0x01, 0, 0, 0]), MATRIX, u32(0, 0));
    const mvhd = box('mvhd', u32(0, 0, 0, timescale, duration, 0x00010000), Buffer.from([0x01, 0, 0, 0]), u32(0, 0), MATRIX, u32(0, 0, 0, 0, 0, 0, 2));
    return box('moov', mvhd, box('trak', tkhd, box('mdia', mdhd, hdlr, minf)));
  };
  const ftyp = box('ftyp', Buffer.from('M4A ', 'latin1'), u32(0), Buffer.from('M4A mp42isom', 'latin1'));
  const size = build(0).length;
  const moov = build(ftyp.length + size + 8);
  const data = Buffer.concat(samples.map((s) => src.subarray(s.offset, s.offset + s.size)));
  return Buffer.concat([ftyp, moov, box('mdat', data)]);
}

// ---------- WAV ----------

function splitWav(buf: Buffer, partSec: number): SplitRecording {
  let p = 12;
  let fmt: Buffer | null = null;
  let data: { start: number; end: number } | null = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('latin1', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'fmt ') fmt = buf.subarray(body, body + size);
    if (id === 'data') {
      data = { start: body, end: Math.min(buf.length, body + size) };
      break;
    }
    p = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV 录音文件不完整');
  const byteRate = fmt.readUInt32LE(8);
  const align = fmt.readUInt16LE(12) || 1;
  // Keep each piece under ~15 MB (the provider limit is 25 MB after base64) even for 48 kHz stereo files.
  const secs = Math.max(30, Math.min(partSec, Math.floor(15_000_000 / Math.max(1, byteRate))));
  const step = Math.max(align, Math.floor((secs * byteRate) / align) * align);
  const parts: RecordingPart[] = [];
  for (let at = data.start; at < data.end; at += step) {
    const pcm = buf.subarray(at, Math.min(data.end, at + step));
    parts.push({
      data: Buffer.concat([Buffer.from('RIFF', 'latin1'), u32le(4 + 8 + fmt.length + 8 + pcm.length), Buffer.from('WAVEfmt ', 'latin1'), u32le(fmt.length), fmt, Buffer.from('data', 'latin1'), u32le(pcm.length), pcm]),
      mime: 'audio/wav',
      startSec: (at - data.start) / byteRate,
    });
  }
  return { parts, durationSec: (data.end - data.start) / byteRate };
}

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

// ---------- MP3 ----------

const MP3_RATES: Record<number, number[]> = {
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // MPEG-1 layer III
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // MPEG-2 / 2.5 layer III
};
const MP3_SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function mp3Frame(buf: Buffer, p: number): { len: number; samples: number; rate: number } | null {
  if (p + 4 > buf.length || buf[p] !== 0xff || (buf[p + 1] & 0xe0) !== 0xe0) return null;
  const ver = (buf[p + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const layer = (buf[p + 1] >> 1) & 3; // 1 = layer III
  if (ver === 1 || layer !== 1) return null;
  const br = MP3_RATES[ver === 3 ? 3 : 2][buf[p + 2] >> 4];
  const sr = MP3_SAMPLE_RATES[ver]?.[(buf[p + 2] >> 2) & 3];
  if (!br || !sr) return null;
  const pad = (buf[p + 2] >> 1) & 1;
  const samples = ver === 3 ? 1152 : 576;
  return { len: Math.floor(((samples / 8) * br * 1000) / sr) + pad, samples, rate: sr };
}

function id3End(buf: Buffer): number {
  if (buf.toString('latin1', 0, 3) !== 'ID3') return 0;
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  return 10 + size;
}

function isMp3(buf: Buffer): boolean {
  const p = id3End(buf);
  const f = mp3Frame(buf, p);
  return !!f && !!mp3Frame(buf, p + f.len);
}

function splitMp3(buf: Buffer, partSec: number): SplitRecording {
  const parts: RecordingPart[] = [];
  let p = id3End(buf);
  // A leading Xing/Info frame states the whole file's length; players would read the first piece as that long.
  const first = mp3Frame(buf, p);
  if (first && /Xing|Info|VBRI/.test(buf.toString('latin1', p + 4, p + Math.min(first.len, 64)))) p += first.len;
  const start = p;
  let total = 0;
  for (let q = p; q < buf.length; ) {
    const f = mp3Frame(buf, q);
    if (!f) q++;
    else ((total += f.samples / f.rate), (q += f.len));
  }
  p = start;
  let from = p;
  let t = 0;
  let partT = 0;
  while (p < buf.length) {
    const f = mp3Frame(buf, p);
    if (!f) {
      p++; // resync after junk
      continue;
    }
    if (t - partT >= partSec && p > from && total - t >= partSec * 0.2) {
      parts.push({ data: buf.subarray(from, p), mime: 'audio/mpeg', startSec: partT });
      from = p;
      partT = t;
    }
    t += f.samples / f.rate;
    p += f.len;
  }
  if (from < buf.length) parts.push({ data: buf.subarray(from), mime: 'audio/mpeg', startSec: partT });
  return { parts, durationSec: t };
}
