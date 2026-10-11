import type { PcmAudio } from "../engine/analyzer";

/** Minimal RIFF/WAVE reader: PCM 8/16/24/32-bit integer and 32/64-bit float. */
export function decodeWav(bytes: Uint8Array): PcmAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a RIFF/WAVE file");

  let format = 0, channels = 0, sampleRate = 0, bits = 0;
  let dataOffset = -1, dataLength = 0;
  for (let o = 12; o + 8 <= bytes.length;) {
    const id = tag(o);
    const size = view.getUint32(o + 4, true);
    if (id === "fmt ") {
      format = view.getUint16(o + 8, true);
      channels = view.getUint16(o + 10, true);
      sampleRate = view.getUint32(o + 12, true);
      bits = view.getUint16(o + 22, true);
      if (format === 0xfffe) format = view.getUint16(o + 32, true); // WAVE_FORMAT_EXTENSIBLE sub-format
    } else if (id === "data") {
      dataOffset = o + 8;
      dataLength = Math.min(size, bytes.length - dataOffset);
    }
    o += 8 + size + (size & 1);
  }
  if (dataOffset < 0 || !channels) throw new Error("WAV is missing fmt or data chunk");
  if (format !== 1 && format !== 3) throw new Error(`Unsupported WAV format ${format} (PCM and IEEE float only)`);

  const bytesPerSample = bits / 8;
  const frames = Math.floor(dataLength / (bytesPerSample * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const o = dataOffset + (f * channels + c) * bytesPerSample;
      let v: number;
      if (format === 3) v = bits === 64 ? view.getFloat64(o, true) : view.getFloat32(o, true);
      else if (bits === 8) v = (view.getUint8(o) - 128) / 128;
      else if (bits === 16) v = view.getInt16(o, true) / 32768;
      else if (bits === 24) v = (((view.getUint8(o + 2) << 24) | (view.getUint8(o + 1) << 16) | (view.getUint8(o) << 8)) >> 8) / 8388608;
      else if (bits === 32) v = view.getInt32(o, true) / 2147483648;
      else throw new Error(`Unsupported bit depth ${bits}`);
      out[c][f] = v;
    }
  }
  return { sampleRate, channels: out };
}

/** 16-bit PCM WAV encoder (used by tests and for exporting demo tracks). */
export function encodeWav16(audio: PcmAudio): Uint8Array {
  const ch = audio.channels.length;
  const frames = audio.channels[0].length;
  const dataLen = frames * ch * 2;
  const buf = new Uint8Array(44 + dataLen);
  const v = new DataView(buf.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < 4; i++) buf[o + i] = s.charCodeAt(i); };
  w(0, "RIFF"); v.setUint32(4, 36 + dataLen, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, audio.sampleRate, true); v.setUint32(28, audio.sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, dataLen, true);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, audio.channels[c][f]));
      v.setInt16(44 + (f * ch + c) * 2, Math.round(s * 32767), true);
    }
  }
  return buf;
}
