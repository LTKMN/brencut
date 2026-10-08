// Liene PixCut S1 USB protocol (reverse-engineered by popcornhax/PixCut-App, MIT).
//
// The printer is a vendor-specific USB device (VID 0x302C, PID 0x3101). Interface 2 carries JSON
// commands: the ASCII line `cmd json\n` followed by compact JSON (no trailing newline) on bulk OUT
// 0x06, replies on bulk IN 0x86. Interface 3 carries file data in chunks: `cmd data EXTLEN=<n>\n`,
// a little-endian u32 job id, then n-4 payload bytes, on bulk OUT 0x04; each chunk is answered
// with `... OK` or `... ER <msg>` on bulk IN 0x84.
//
// Transport-agnostic: `io` is { write(ep, Uint8Array), read(ep, maxLen, timeoutMs) -> Uint8Array }.

export const VID = 0x302c;
export const PID = 0x3101;
export const CTRL = { iface: 2, out: 0x06, in: 0x86 };
export const DATA = { iface: 3, out: 0x04, in: 0x84 };

// 4x7 sticker stock. The printer's raster is 1216x2128; a 1200x2100 300-DPI sheet is padded
// 8px left/right and 14px top/bottom into it.
export const MEDIA_4X7 = 5013;
export const SHEET = { w: 1200, h: 2100, padX: 8, padY: 14, rasterW: 1216, rasterH: 2128 };
export const MAX_JPEG_BYTES = 1024 * 1024;

const CHUNK_EXTLEN = 4075; // 4096-byte transfers including the header line
const CHUNK_DELAY_MS = 120; // matches the vendor app's pacing
// Constant hash seen in captures; the firmware does not appear to verify it.
const CAPTURED_HASH = '26b8714aea78792854637621ad5cf1c4ed31ad1f';
const CAPTURED_UUID = 'f45d69a1da22727c26aa863ea657de8b32a501f2';

export const PRINTER_STATE = { 10: 'initializing', 20: 'idle', 30: 'asleep', 40: 'busy', 50: 'off', 60: 'error' };
export const JOB_STATE = { 1: 'waiting', 2: 'starting', 3: 'processing', 4: 'held', 5: 'pending', 6: 'terminating', 7: 'aborted', 8: 'cancelled', 9: 'completed' };
export const SUB_STATE = {
  1000: 'init', 2000: 'idle', 3001: 'printing', 3002: 'receiving file', 3005: 'printing', 3006: 'cancelling',
  3014: 'rendering', 3015: 'initializing', 3016: 'decoding', 3017: 'loading paper', 3018: 'printing yellow',
  3019: 'printing magenta', 3020: 'printing cyan', 3021: 'laminating', 3022: 'preheating', 3023: 'cooling down',
  3025: 'feeding', 3026: 'ejecting', 3028: 'picking for cut', 3029: 'cutter homing', 3030: 'cutting',
  3031: 'ejecting cut sheet', 7000: 'aborted', 8000: 'cancelled', 9000: 'completed',
};
// Alerts the user can fix (paper, ribbon, door); anything else ends the job.
export const ALERTS = {
  5001: 'paper jam', 5306: 'paper feed problem', 5401: 'out of paper', 5402: 'paper cassette missing',
  5417: 'wrong paper loaded', 5418: 'wrong paper loaded', 5419: 'wrong paper loaded', 5420: 'wrong paper loaded',
  5506: 'cover open', 8101: 'ribbon problem', 8102: 'no ribbon', 8104: 'ribbon used up', 8106: 'wrong ribbon',
};

const enc = new TextEncoder();
const dec = new TextDecoder('latin1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Frame a JSON command. */
export function frameJson(obj) {
  return enc.encode('cmd json\n' + JSON.stringify(obj));
}

/** Split a payload into framed data chunks for job `jobId`. */
export function* frameData(payload, jobId, extlen = CHUNK_EXTLEN) {
  const max = extlen - 4;
  for (let off = 0; off < payload.length; off += max) {
    const body = payload.subarray(off, off + max);
    const head = enc.encode(`cmd data EXTLEN=${body.length + 4}\n`);
    const pkt = new Uint8Array(head.length + 4 + body.length);
    pkt.set(head, 0);
    new DataView(pkt.buffer).setUint32(head.length, jobId >>> 0, true);
    pkt.set(body, head.length + 4);
    yield pkt;
  }
}

/** Pull complete top-level JSON objects out of a text buffer. Returns [objects, rest]. */
export function takeJson(text) {
  const out = [];
  let i = text.indexOf('{');
  let start = i;
  let depth = 0, inStr = false, esc = false;
  let consumed = 0;
  for (; i >= 0 && i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}' && depth > 0 && --depth === 0) {
      const raw = text.slice(start, i + 1).replace(/[\0\r]/g, '');
      try { out.push(JSON.parse(raw)); } catch { /* skip garbage */ }
      consumed = i + 1;
    }
  }
  return [out, text.slice(consumed)];
}

/** "::8102" or ["::0"] -> [8102]. Zero means no alert. */
export function alertCodes(v) {
  const codes = [];
  for (const m of JSON.stringify(v ?? '').matchAll(/::(\d+)/g)) {
    const n = Number(m[1]);
    if (n) codes.push(n);
  }
  return codes;
}

export function describeAlerts(codes) {
  return codes.map((c) => `${c} ${ALERTS[c] ?? 'printer error'}`).join(', ');
}

export class PixCut {
  constructor(io, log = () => {}) {
    this.io = io;
    this.log = log;
    this.nextId = (Date.now() & 0x7fff) + 1;
    this.pending = '';
    this.busy = Promise.resolve();
  }

  // One request at a time; the reply is matched by id, unsolicited events are logged.
  request(method, params) {
    const run = async () => {
      const id = this.nextId++;
      await this.io.write(CTRL.out, frameJson({ id, method, params }));
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const chunk = await this.io.read(CTRL.in, 4096, Math.max(100, deadline - Date.now()));
        if (!chunk?.length) continue;
        const [objs, rest] = takeJson(this.pending + dec.decode(chunk));
        this.pending = rest.length > 65536 ? '' : rest;
        for (const o of objs) {
          if (o.id === id) return o;
          if (o.method === 'event.rpt_err') throw new Error(`printer error event: ${JSON.stringify(o.params ?? o)}`);
          this.log('event', o);
        }
      }
      throw new Error(`no reply to ${method}`);
    };
    const p = this.busy.then(run, run);
    this.busy = p.catch(() => {});
    return p;
  }

  async getProps(names) {
    const r = await this.request('get-prop', names);
    const vals = Array.isArray(r.result) ? r.result : [];
    const out = {};
    names.forEach((n, i) => {
      const v = vals[i];
      out[n] = v && typeof v === 'object' && n in v ? v[n] : v;
    });
    return out;
  }

  async status() {
    const p = await this.getProps(['printer-state', 'printer-sub-state', 'printer-state-alerts']);
    const state = Number(p['printer-state']);
    const sub = Number(p['printer-sub-state']);
    const alerts = alertCodes(p['printer-state-alerts']);
    return { state, sub, alerts, label: PRINTER_STATE[state] ?? `state ${state}`, subLabel: SUB_STATE[sub] ?? `${sub}` };
  }

  async identify() {
    return this.getProps(['model', 'sku', 'firmware-revision', 'hardware-revision', 'media-size']);
  }

  async jobInfo(jobId) {
    const r = await this.request('get-job-info', { 'job-id': jobId });
    let info = Array.isArray(r.result) ? r.result[0] : r.result;
    if (info && typeof info.info === 'object') info = info.info;
    return info && typeof info === 'object' ? info : null;
  }

  async cancel(jobId) {
    return this.request('cancel-job', { 'job-id': Number(jobId) });
  }

  async activeJobs() {
    const r = await this.request('get-job-id-list', {});
    return String(JSON.stringify(r.result ?? '')).match(/\d+/g)?.map(Number).filter((n) => n > 0) ?? [];
  }

  /** Declare a print+cut job. Returns the job id the printer assigns. */
  async createComboJob(jpeg, plt, { copies = 1, quality = 4 } = {}) {
    const name = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    const r = await this.request('combo-job', [
      { method: 'print-job', params: {
        uuid: CAPTURED_UUID, 'job-url': '', 'print-quality': quality, copies,
        'document-name': `${name}.jpg`, 'file-size': jpeg.length, 'document-format': 9,
        'hash-method': 1, 'hash-value': CAPTURED_HASH, 'media-size': MEDIA_4X7, 'media-type': 2030,
        'user-account': '12345678', 'job-type': 600, channel: 14864, timeout: 180,
      } },
      { method: 'cut-job', params: {
        'file-size': plt.length, 'document-format': 18, 'document-name': `${name}.plt`, 'job-url': '',
        'hash-method': 1, 'hash-value': CAPTURED_HASH, timeout: 100,
      } },
    ]);
    const res = r.result;
    const flat = JSON.stringify(res ?? '');
    const err = flat.match(/"error-code"\s*:\s*(\d+)/);
    const id = (Array.isArray(res) ? res : [res]).map((v) => (typeof v === 'object' && v ? v['job-id'] ?? v.job_id : v))
      .map(Number).find((n) => n > 0);
    if (!id) throw new Error(err ? `printer rejected the job (error ${err[1]}${ALERTS[err[1]] ? ': ' + ALERTS[err[1]] : ''})` : `no job id in reply: ${flat}`);
    return id;
  }

  /** Upload one file to job `jobId`, waiting for each chunk's OK. */
  async upload(payload, jobId, onProgress = () => {}) {
    const chunks = [...frameData(payload, jobId)];
    for (let i = 0; i < chunks.length; i++) {
      await this.io.write(DATA.out, chunks[i]);
      let ack = '';
      const deadline = Date.now() + 10000;
      while (!/\b(OK|ER)\b/.test(ack)) {
        if (Date.now() > deadline) throw new Error(`no acknowledgement for chunk ${i + 1}/${chunks.length}`);
        const r = await this.io.read(DATA.in, 4096, Math.max(100, deadline - Date.now()));
        if (r?.length) ack += dec.decode(r);
        const [objs, rest] = takeJson(ack);
        for (const o of objs) if (o.method === 'event.rpt_err') throw new Error(`printer error during upload: ${JSON.stringify(o.params ?? o)}`);
        if (objs.length) ack = rest;
      }
      if (/\bER\b/.test(ack)) throw new Error(`printer refused chunk ${i + 1}: ${ack.trim()}`);
      onProgress((i + 1) / chunks.length);
      if (CHUNK_DELAY_MS) await sleep(CHUNK_DELAY_MS);
    }
  }

  /**
   * Run a full print-and-cut: declare, upload PLT then JPEG, poll until done.
   * `onStatus({phase, text, progress})` reports along the way. `signal` (AbortSignal) cancels.
   */
  async printAndCut(jpeg, plt, { onStatus = () => {}, signal } = {}) {
    if (jpeg.length > MAX_JPEG_BYTES) throw new Error(`print image is ${jpeg.length} bytes; the printer takes at most 1 MiB`);
    const pre = await this.status();
    if (pre.state === 60 || pre.alerts.length) throw new Error(`printer not ready: ${describeAlerts(pre.alerts) || pre.subLabel}`);
    if (pre.state === 40) throw new Error('printer is busy with another job');

    onStatus({ phase: 'declare', text: 'declaring job' });
    const jobId = await this.createComboJob(jpeg, plt);
    const heartbeat = setInterval(() => this.status().catch(() => {}), 5000);
    try {
      const total = plt.length + jpeg.length;
      onStatus({ phase: 'upload', text: `job ${jobId}: sending cut path`, progress: 0, jobId });
      await this.upload(plt, jobId, (f) => onStatus({ phase: 'upload', text: `job ${jobId}: sending cut path`, progress: (f * plt.length) / total, jobId }));
      onStatus({ phase: 'upload', text: `job ${jobId}: sending image`, progress: plt.length / total, jobId });
      await this.upload(jpeg, jobId, (f) => onStatus({ phase: 'upload', text: `job ${jobId}: sending image`, progress: (plt.length + f * jpeg.length) / total, jobId }));
    } finally {
      clearInterval(heartbeat);
    }

    let sawCut = false;
    let idleAfterDone = 0;
    let missed = 0;
    for (;;) {
      if (signal?.aborted) {
        await this.cancel(jobId).catch(() => {});
        throw new Error(`job ${jobId} cancelled`);
      }
      await sleep(2000);
      let st, info;
      try {
        st = await this.status();
        info = await this.jobInfo(jobId);
        missed = 0;
      } catch (e) {
        if (++missed >= 5) throw e;
        continue;
      }
      if (st.sub >= 3028 && st.sub <= 3031) sawCut = true;
      const js = Number(info?.['job-state']);
      const jsub = Number(info?.['job-sub-state']);
      if (jsub >= 3028 && jsub <= 3031 || Number(info?.['cut-contours']) > 0) sawCut = true;
      const cut = info?.['cut-contours'] ? ` · cut ${info['cutting-progress'] ?? 0}/${info['cut-contours']}` : '';
      const alert = st.alerts.length ? ` · ${describeAlerts(st.alerts)}` : '';
      onStatus({ phase: 'run', text: `job ${jobId}: ${JOB_STATE[js] ?? st.label} · ${SUB_STATE[jsub] ?? st.subLabel}${cut}${alert}`, jobId, alerts: st.alerts });

      if (st.state === 60 && st.alerts.some((c) => !(c in ALERTS))) throw new Error(`printer error: ${describeAlerts(st.alerts)}`);
      if (js === 8 || js === 7) throw new Error(`job ${jobId} ${JOB_STATE[js]}`);
      if (js === 9 || jsub === 9000 || (!info && sawCut)) {
        if (st.state === 20 || ++idleAfterDone >= 15) return { jobId, cut: sawCut };
      }
    }
  }
}
