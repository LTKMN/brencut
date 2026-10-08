// WebUSB adapter for src/protocol.js (Chromium browsers: Chrome, Edge, Opera, Brave).
//
// WebUSB's transferIn has no timeout and can't be cancelled, so each IN endpoint gets one
// long-lived reader that feeds a queue; read() takes from the queue with a timeout.
import { VID, PID, CTRL, DATA } from './protocol.js';

export const supported = () => typeof navigator !== 'undefined' && !!navigator.usb;

class InPipe {
  constructor(dev, num) {
    this.dev = dev;
    this.num = num;
    this.queue = [];
    this.waiters = [];
    this.alive = true;
    this.loop();
  }
  async loop() {
    while (this.alive) {
      try {
        const r = await this.dev.transferIn(this.num, 4096);
        if (r.status === 'stall') await this.dev.clearHalt('in', this.num);
        if (r.data?.byteLength) this.push(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
      } catch (e) {
        if (!this.alive) return;
        this.error = e;
        this.push(null);
        return;
      }
    }
  }
  push(chunk) {
    const w = this.waiters.shift();
    if (w) w(chunk);
    else this.queue.push(chunk);
  }
  read(timeoutMs) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((res, rej) => {
      const done = (c) => {
        clearTimeout(t);
        if (c === null) rej(this.error ?? new Error('USB connection lost'));
        else res(c);
      };
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(done);
        if (i >= 0) this.waiters.splice(i, 1);
        res(new Uint8Array());
      }, timeoutMs);
      this.waiters.push(done);
    });
  }
  stop() {
    this.alive = false;
  }
}

/** Already-permitted printer, without a prompt. */
export async function findGranted() {
  if (!supported()) return null;
  const devs = await navigator.usb.getDevices();
  return devs.find((d) => d.vendorId === VID && d.productId === PID) ?? null;
}

/** Ask the user to pick the printer (must be called from a click). */
export async function requestPrinter() {
  return navigator.usb.requestDevice({ filters: [{ vendorId: VID, productId: PID }] });
}

export async function openPrinter(dev) {
  await dev.open();
  if (!dev.configuration) await dev.selectConfiguration(1);
  await dev.claimInterface(CTRL.iface);
  await dev.claimInterface(DATA.iface);
  const pipes = new Map([
    [CTRL.in, new InPipe(dev, CTRL.in & 0x0f)],
    [DATA.in, new InPipe(dev, DATA.in & 0x0f)],
  ]);
  const io = {
    async write(ep, bytes) {
      const r = await dev.transferOut(ep & 0x0f, bytes);
      if (r.status !== 'ok') throw new Error(`USB write ${r.status}`);
    },
    read: (ep, _len, timeoutMs) => pipes.get(ep).read(timeoutMs),
  };
  const close = async () => {
    for (const p of pipes.values()) p.stop();
    try { await dev.close(); } catch { /* already gone */ }
  };
  return { io, close, device: dev };
}
