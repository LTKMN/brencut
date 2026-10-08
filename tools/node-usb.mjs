// node-usb adapter for src/protocol.js, so the same protocol code can be driven from a terminal.
import { findByIds } from 'usb';
import { VID, PID, CTRL, DATA } from '../src/protocol.js';

export function openPrinter() {
  const dev = findByIds(VID, PID);
  if (!dev) throw new Error('PixCut S1 not found on USB');
  dev.open();
  const ifaces = [dev.interface(CTRL.iface), dev.interface(DATA.iface)];
  for (const i of ifaces) i.claim();
  const eps = new Map();
  for (const i of ifaces) for (const e of i.endpoints) eps.set(e.address, e);

  const io = {
    write: (ep, bytes) => new Promise((res, rej) => eps.get(ep).transfer(Buffer.from(bytes), (e) => (e ? rej(e) : res()))),
    read: (ep, len, timeoutMs) => new Promise((res, rej) => {
      const e = eps.get(ep);
      e.timeout = Math.round(timeoutMs);
      e.transfer(len, (err, d) => {
        if (err?.errno === 2 /* LIBUSB_TRANSFER_TIMED_OUT */ || /TIMED_OUT/.test(String(err))) return res(new Uint8Array());
        return err ? rej(err) : res(new Uint8Array(d));
      });
    }),
  };
  const close = () => new Promise((res) => {
    let n = ifaces.length;
    for (const i of ifaces) i.release(true, () => { if (--n === 0) { dev.close(); res(); } });
  });
  return { io, close };
}
