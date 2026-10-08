// Read-only: print the printer's identity, state and any active jobs.
import { PixCut, describeAlerts } from '../src/protocol.js';
import { openPrinter } from './node-usb.mjs';

const { io, close } = openPrinter();
try {
  const p = new PixCut(io, (kind, o) => console.log(kind, JSON.stringify(o)));
  console.log('identity', await p.identify());
  const s = await p.status();
  console.log('status  ', `${s.label} / ${s.subLabel}`, s.alerts.length ? describeAlerts(s.alerts) : 'no alerts');
  console.log('jobs    ', await p.activeJobs());
} finally {
  await close();
}
