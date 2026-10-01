import type { DeviceType, Plugin } from '../devices/types';
import { crosspoint } from './crosspoint';

/** The plugins built into nexlibris. */
export const PLUGINS: Plugin[] = [crosspoint];

export const DEVICE_TYPES: DeviceType[] = PLUGINS.flatMap((p) => p.deviceTypes);

export const deviceType = (id: string) => DEVICE_TYPES.find((t) => t.id === id);
