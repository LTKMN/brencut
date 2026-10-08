/**
 * Reference tables recovered from the Liene Photo desktop app.
 *
 * Model, media and error tables come from the shipped
 * `packages/ht_device_kit/assets/pluginInfo.json`. Operation names come from the
 * protocol builders in the Dart snapshot. Nothing here talks to a printer: this
 * library has no transport layer, so these are constants for tooling and diagnostics.
 */

/** A printer in the Hannto plugin registry. */
export interface PrinterModel {
  /** Internal model identifier. */
  readonly model: string;
  /** Retail product name. */
  readonly product: string;
  /** Product identifier from the registry. */
  readonly pid: number;
  /** Registry `protocolType`. */
  readonly protocolType: number;
  /** Registry `connectType`. */
  readonly connectType: number;
  /** Whether the machine has a knife carriage. */
  readonly hasCutter: boolean;
}

export const PRINTER_MODELS: readonly PrinterModel[] = [
  {
    model: 'hannto.printer.perilla',
    product: 'Liene PixCut S1',
    pid: 3101,
    protocolType: 1,
    connectType: 8,
    hasCutter: true,
  },
  {
    model: 'hannto.printer.cumin',
    product: 'Liene Pearl N200 Pro',
    pid: 3015,
    protocolType: 1,
    connectType: 8,
    hasCutter: false,
  },
  {
    model: 'hannto.printer.laurel',
    product: 'Liene Amber M110/M210',
    pid: 3007,
    protocolType: 1,
    connectType: 8,
    hasCutter: false,
  },
  {
    model: 'hannto.printer.fennel',
    product: 'Liene Photo Printer',
    pid: 3005,
    protocolType: 2,
    connectType: 2,
    hasCutter: false,
  },
  {
    model: 'hannto.printer.kiwi',
    product: 'Portable Photo Printer',
    pid: 1021,
    protocolType: 2,
    connectType: 8,
    hasCutter: false,
  },
];

/** The PixCut S1's registry entry. */
export const PIXCUT_S1: PrinterModel = PRINTER_MODELS[0]!;

/** Paper size codes accepted in the `media-size` job parameter. */
export const MEDIA_SIZES: Readonly<Record<number, string>> = {
  5012: '4x6',
  5013: '4x7',
};

/** Paper type codes accepted in the `media-type` job parameter. */
export const MEDIA_TYPES: Readonly<Record<number, string>> = {
  2010: 'photo paper',
  2030: '4x7 adhesive photo paper',
};

/** Print-job limits from the PixCut S1's `print_config` block. */
export const PRINT_LIMITS = {
  maxCopies: 9,
  maxPages: 1,
} as const;

/** What the app does when the firmware reports an error. */
export type ErrorRecovery = 'resume-printer' | 'manual';

/** Which subsystem an error code belongs to. */
export type ErrorCategory = 'paper' | 'ribbon' | 'cutter';

export interface PrinterError {
  readonly code: number;
  readonly category: ErrorCategory;
  readonly summary: string;
  readonly recovery: ErrorRecovery;
}

/** Error codes carried in the PixCut S1's `error-handle-parameter` block. */
export const PRINTER_ERRORS: readonly PrinterError[] = [
  { code: 5199, category: 'paper', summary: 'Unknown paper', recovery: 'manual' },
  { code: 5306, category: 'paper', summary: 'Paper cassette not installed', recovery: 'resume-printer' },
  { code: 5401, category: 'paper', summary: 'Out of paper', recovery: 'resume-printer' },
  { code: 5402, category: 'paper', summary: 'Pick failure, sheet not taken', recovery: 'manual' },
  { code: 5403, category: 'paper', summary: 'Paper jam', recovery: 'manual' },
  { code: 5414, category: 'paper', summary: 'Paper length mismatch', recovery: 'resume-printer' },
  { code: 5415, category: 'paper', summary: 'Eject failure', recovery: 'manual' },
  { code: 5416, category: 'paper', summary: 'Paper length mismatch', recovery: 'manual' },
  { code: 8101, category: 'ribbon', summary: 'Ribbon exhausted', recovery: 'resume-printer' },
  { code: 8102, category: 'ribbon', summary: 'No ribbon cartridge', recovery: 'resume-printer' },
  { code: 8103, category: 'ribbon', summary: 'Ribbon fault', recovery: 'manual' },
  { code: 8104, category: 'ribbon', summary: 'Wrong ribbon type', recovery: 'resume-printer' },
  { code: 8105, category: 'ribbon', summary: 'Ribbon jam', recovery: 'manual' },
  { code: 8199, category: 'ribbon', summary: 'Unknown ribbon error', recovery: 'manual' },
  { code: 8401, category: 'cutter', summary: 'Jam at the cutter', recovery: 'manual' },
  { code: 8402, category: 'cutter', summary: 'Jam at the cutter', recovery: 'resume-printer' },
  { code: 8403, category: 'cutter', summary: 'Jam at the cutter', recovery: 'resume-printer' },
  { code: 8404, category: 'cutter', summary: 'Blade carriage failed to return home', recovery: 'resume-printer' },
  { code: 8405, category: 'cutter', summary: 'Jam under the machine', recovery: 'manual' },
  { code: 8406, category: 'cutter', summary: 'Blade holder obstruction', recovery: 'manual' },
  { code: 8407, category: 'cutter', summary: 'Blade holder obstruction', recovery: 'manual' },
  { code: 8408, category: 'cutter', summary: 'Blade carriage failed to return home', recovery: 'resume-printer' },
  { code: 8409, category: 'cutter', summary: 'Blade carriage recovery needed', recovery: 'manual' },
  { code: 8410, category: 'cutter', summary: 'Blade carriage recovery needed', recovery: 'manual' },
  { code: 8411, category: 'cutter', summary: 'Blade carriage recovery needed', recovery: 'resume-printer' },
  { code: 8412, category: 'cutter', summary: 'Blade carriage recovery needed', recovery: 'resume-printer' },
  { code: 8413, category: 'cutter', summary: 'Jam under the machine', recovery: 'manual' },
];

/** Look up an error code. */
export function findPrinterError(code: number): PrinterError | undefined {
  return PRINTER_ERRORS.find((error) => error.code === code);
}

/** Protocol operations the app's command builders produce. */
export const PROTOCOL_OPERATIONS = [
  'get-prop',
  'set-prop',
  'device-info',
  'create-job',
  'combo-job',
  'get-job-info',
  'cancel-job',
  'resume-printer',
  'ribbon-info',
  'ota-info',
  'upgrade-firmware',
  'auto-off-interval',
] as const;

export type ProtocolOperation = (typeof PROTOCOL_OPERATIONS)[number];

/** Job kinds the firmware distinguishes. A combo job prints and then cuts in one pass. */
export const JOB_TYPES = ['print', 'cut', 'print-cut', 'upgrade'] as const;

export type JobType = (typeof JOB_TYPES)[number];

/** Transport facts, for tools that go on to implement a link. */
export const TRANSPORT = {
  /** BLE service whose advertisement service data carries the VID, PID and MAC. */
  bleServiceUuid: '0000fc00-0000-1000-8000-00805f9b34fb',
  /** USB interface descriptor names for the command and data endpoints. */
  usbInterfaceNames: { command: 'WinEg', data: 'WinE2' },
  /** Advertised Bluetooth name pattern; the suffix is the last four of the MAC. */
  advertisedNamePattern: 'Liene PixCut S1 - XXXX',
} as const;
