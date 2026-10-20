import type { InstanceType } from '../devices/types';
import { INSTANCE_TYPE } from '../sync/instances';

/**
 * Another instance of nexlibris: its connection's catalog is what it's shown (what it can browse and
 * download from here, and what Sync to sends it), and it shows this one its own connection's catalog
 * for this one. Every file of a book goes.
 */
export const instanceType: InstanceType = {
  access: 'instance',
  id: INSTANCE_TYPE,
  label: 'Nexlibris twin',
  activation: 'manual',
  read: true,
  write: { single: true },
  formats: () => [],
  settings: [],
};
