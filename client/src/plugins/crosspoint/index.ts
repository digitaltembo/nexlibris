import type { Device } from '@nexlibris/common';
import type { DeviceType, Plugin, SettingField } from '../../devices/types';
import { embedMetadata } from '../../devices/embedMetadata';
import { xteinkConverter } from '../../formats/convert/converters';
import { DEFAULT_OPTIMIZE_OPTIONS, type OptimizeOptions } from '../../formats/convert/xteink/options';
import { CrossPointTarget } from './client';

const settings: SettingField[] = [
  {
    key: 'address',
    label: 'Address',
    default: 'http://crosspoint.local',
    help: 'Shown on the reader in File Transfer mode. Use its IP address if crosspoint.local doesn’t work.',
  },
  { key: 'folder', label: 'Folder', default: '/Books', help: 'Where books go on the SD card.' },
  {
    key: 'catalogUrl',
    label: 'Catalog URL',
    default: '',
    help: 'Where you host the OPDS catalog exported for this device, if you do. Syncing adds it to the reader’s OPDS libraries.',
  },
  {
    key: 'quality',
    label: 'Image quality',
    default: String(DEFAULT_OPTIMIZE_OPTIONS.quality),
    range: { min: 1, max: 100 },
    help: 'JPEG quality of images in the optimized copy. Lower is smaller and faster to open.',
  },
  {
    key: 'grayscale',
    label: 'Images',
    default: 'yes',
    choices: [
      { value: 'yes', label: 'Grayscale' },
      { value: 'no', label: 'Keep colour' },
    ],
    help: 'The screen is grayscale; colour images are larger for no gain on it.',
  },
  {
    key: 'autoCrop',
    label: 'Crop image margins',
    default: 'no',
    choices: [
      { value: 'no', label: 'No' },
      { value: 'yes', label: 'Yes' },
    ],
    help: 'Trims plain margins so illustrations fill the screen. Sparse pages can end up zoomed a lot.',
  },
  {
    key: 'splitText',
    label: 'Split long text',
    default: 'yes',
    choices: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
    help: 'Splits very long paragraphs and chapters, and drops embedded fonts, so the reader has the memory to open them.',
  },
];

const setting = (device: Device, key: string) => {
  const value = device.settings[key];
  return typeof value === 'string' && value.trim() ? value.trim() : settings.find((s) => s.key === key)!.default;
};

/** The optimizer options a device's settings ask for. Changing them makes the next sync remake its optimized copies. */
export function optimizeOptions(device: Device): OptimizeOptions {
  const quality = Math.round(Number(setting(device, 'quality')));
  return {
    quality: quality >= 1 && quality <= 100 ? quality : DEFAULT_OPTIMIZE_OPTIONS.quality,
    grayscale: setting(device, 'grayscale') !== 'no',
    autoCrop: setting(device, 'autoCrop') === 'yes',
    splitText: setting(device, 'splitText') !== 'no',
  };
}

function deviceType(id: string, label: string, profile: 'X4' | 'X3'): DeviceType {
  const optimized = profile === 'X4' ? 'x4.epub' : 'x3.epub';
  return {
    id,
    label,
    // The copy optimized for the device, made from the EPUB when the book doesn't have one yet.
    formats: [optimized, 'epub'],
    makes: (device) => xteinkConverter(profile, optimizeOptions(device)),
    settings,
    folder: (device) => `/${setting(device, 'folder').replace(/^\/+|\/+$/g, '')}`,
    prepare: embedMetadata,
    catalog: (device) => {
      const url = setting(device, 'catalogUrl');
      return url ? { name: device.name, url } : undefined;
    },
    target: (device) => new CrossPointTarget(setting(device, 'address')),
  };
}

/** Xteink X4 and X3 readers running CrossPoint firmware. */
export const crosspoint: Plugin = {
  id: 'crosspoint',
  name: 'CrossPoint',
  deviceTypes: [
    deviceType('crosspoint.x4', 'Xteink X4 (CrossPoint)', 'X4'),
    deviceType('crosspoint.x3', 'Xteink X3 (CrossPoint)', 'X3'),
  ],
};
