// Real-interaction parity probes, grouped by interaction surface.
import { inputProbes } from './interactions-input.mjs';
import { windowProbes } from './interactions-window.mjs';
import { frameProbes } from './interactions-frames.mjs';

export const probes = [...inputProbes, ...windowProbes, ...frameProbes];
