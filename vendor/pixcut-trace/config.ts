import type { GenerateOptions } from './generate.ts';
import type { KernelShape } from './mask.ts';

/**
 * The JSON configuration shape used by `ht_plt_core.dll`, as returned by its
 * `plt_get_default_config` entry point.
 *
 * Provided so existing configuration files port across unchanged. Fields this
 * library does not act on are listed in {@link IGNORED_STOCK_FIELDS}.
 */
export interface StockConfig {
  'kernel-shape'?: string;
  'filtered-min-area'?: number;
  'circle-fitting'?: {
    enabled?: boolean;
    'circularity-threshold'?: number;
    'num-of-edges'?: number;
  };
  'douglas-peucker'?: {
    enabled?: boolean;
    'min-epsilon'?: number;
    'max-epsilon'?: number;
    steps?: number;
    complexity?: {
      circumference?: number;
      curvature?: number;
      convexity?: number;
      gradient?: number;
    };
  };
  'visvalingam-whyatt'?: {
    enabled?: boolean;
    'max-area'?: number;
  };
  extension?: {
    enabled?: boolean;
    'inner-enabled'?: boolean;
    'max-degree'?: number;
    'max-length'?: number;
    steps?: number;
  };
  image?: {
    margin?: number;
    'fill-method'?: string;
    'scale-ratio'?: number;
    binary?: {
      method?: string;
      'png-thresholding'?: boolean;
      threshold?: number;
      'gaussian-blur'?: {
        enabled?: boolean;
        'kernel-size'?: [number, number];
      };
    };
  };
  contours?: {
    internal?: boolean;
    'inner-direction'?: string;
    'outter-direction'?: string;
  };
}

/** The exact defaults `plt_get_default_config` returns. */
export const STOCK_DEFAULT_CONFIG: StockConfig = {
  'kernel-shape': 'morph_ellipse',
  'filtered-min-area': 1,
  'circle-fitting': { enabled: false, 'circularity-threshold': 0.03, 'num-of-edges': 32 },
  'douglas-peucker': {
    enabled: true,
    'min-epsilon': 0.0001,
    'max-epsilon': 0.001,
    steps: 0,
    complexity: { circumference: 0.6, curvature: 0.1, convexity: 0.3, gradient: 0.5 },
  },
  'visvalingam-whyatt': { enabled: true, 'max-area': 15 },
  extension: {
    enabled: true,
    'inner-enabled': true,
    'max-degree': 45,
    'max-length': 1.5,
    steps: 3,
  },
  image: {
    margin: 0,
    'fill-method': 'fit',
    'scale-ratio': 1.01333,
    binary: {
      method: 'thresholding',
      'png-thresholding': true,
      threshold: 240,
      'gaussian-blur': { enabled: false, 'kernel-size': [9, 9] },
    },
  },
  contours: { internal: false, 'inner-direction': 'clockwise', 'outter-direction': 'origin' },
};

/**
 * Stock fields with no effect here.
 *
 * `circle-fitting` replaces near-circular outlines with a regular polygon, which this
 * library leaves to the caller. The `douglas-peucker` epsilon bounds and complexity
 * weights drive an adaptive search whose exact formula is not recoverable from the
 * stock binary, so {@link fromStockConfig} maps them to the midpoint of the bounds;
 * use `simplify.targetPoints` for a deterministic vertex budget instead.
 */
export const IGNORED_STOCK_FIELDS: readonly string[] = [
  'circle-fitting',
  'douglas-peucker.steps',
  'douglas-peucker.complexity',
  'filtered-min-area',
  'contours.inner-direction',
  'contours.outter-direction',
];

function kernelShapeFrom(value: string | undefined): KernelShape {
  if (value === 'morph_rectangle') return 'rectangle';
  if (value === 'morph_cross') return 'cross';
  return 'ellipse';
}

/** Translate a stock configuration object into {@link GenerateOptions}. */
export function fromStockConfig(config: StockConfig): GenerateOptions {
  const vw = config['visvalingam-whyatt'];
  const dp = config['douglas-peucker'];
  const extension = config.extension;
  const image = config.image;
  const binary = image?.binary;
  const blur = binary?.['gaussian-blur'];

  const minEpsilon = dp?.['min-epsilon'] ?? 0.0001;
  const maxEpsilon = dp?.['max-epsilon'] ?? 0.001;

  const options: GenerateOptions = {
    dilationShape: kernelShapeFrom(config['kernel-shape']),
    includeHoles: config.contours?.internal ?? false,
    fillMethod: image?.['fill-method'] === 'fill' ? 'fill' : 'fit',
    scaleRatio: image?.['scale-ratio'] ?? 1.01333,
    margin: image?.margin ?? 0,
    binarize: {
      mode: binary?.['png-thresholding'] === false ? 'luminance' : 'auto',
      threshold: binary?.threshold ?? 240,
      blurKernelSize: blur?.enabled === true ? (blur['kernel-size']?.[0] ?? 9) : 0,
    },
    simplify: {
      maxArea: vw?.enabled === false ? 0 : (vw?.['max-area'] ?? 15),
      epsilonRatio: dp?.enabled === false ? 0 : (minEpsilon + maxEpsilon) / 2,
    },
  };

  if (extension?.enabled === false) {
    options.overcut = false;
  } else {
    options.overcut = {
      steps: extension?.steps ?? 3,
      maxDegree: extension?.['max-degree'] ?? 45,
      maxLength: extension?.['max-length'] ?? 1.5,
    };
    options.overcutHoles = extension?.['inner-enabled'] ?? true;
  }

  return options;
}

/** Deep-merge a partial stock configuration onto {@link STOCK_DEFAULT_CONFIG}. */
export function withStockDefaults(config: StockConfig): StockConfig {
  const merge = (base: unknown, override: unknown): unknown => {
    if (
      typeof base !== 'object' ||
      base === null ||
      Array.isArray(base) ||
      typeof override !== 'object' ||
      override === null ||
      Array.isArray(override)
    ) {
      return override === undefined ? base : override;
    }
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
      out[key] = merge((base as Record<string, unknown>)[key], value);
    }
    return out;
  };
  return merge(STOCK_DEFAULT_CONFIG, config) as StockConfig;
}
