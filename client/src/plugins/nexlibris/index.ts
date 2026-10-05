import type { InstanceType, Plugin } from '../../devices/types';
import { INSTANCE_TYPE } from '../../sync/instances';

/** Another instance of nexlibris that the library syncs with: its connection's books are the ones it gets (sees and keeps the files of). */
export const instanceType: InstanceType = {
  kind: 'instance',
  id: INSTANCE_TYPE,
  label: 'nexlibris on another device',
  formats: [],
  settings: [],
};

/** Sync between instances (M6), as connections. */
export const nexlibris: Plugin = {
  id: 'nexlibris',
  name: 'nexlibris',
  connectionTypes: [instanceType],
};
