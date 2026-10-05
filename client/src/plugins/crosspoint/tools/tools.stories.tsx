import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Modal } from '../../../components/Modal';
import { fakeReader } from '../fakeReader';
import { encodeBmp, SCREEN } from '../sleepImage';
import { Dictionaries } from './Dictionaries';
import { Fonts } from './Fonts';
import { SleepImages } from './SleepImages';

/** A sleep image: a soft diagonal gradient with a band, at the X4's size. */
function sampleBmp(shade: number): Blob {
  const { width, height } = SCREEN.X4;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const band = Math.abs(y - height * shade) < 40 ? 0 : 1;
      const v = band * Math.round(255 * ((x / width + y / height) / 2) * shade + 40 * shade);
      pixels.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  return encodeBmp(pixels, width, height);
}

const text = (s: string) => new Blob([s]);

/** A reader with things on it, made once per story render. */
function useSampleReader() {
  const [fake] = useState(() =>
    fakeReader({
      delay: 150,
      files: {
        '/.sleep/Dawn.bmp': sampleBmp(0.35),
        '/.sleep/Dusk.bmp': sampleBmp(0.7),
        '/dictionaries/webster/webster.idx': text('index'),
        '/dictionaries/webster/webster.dict.dz': new Blob([new Uint8Array(3_400_000)]),
        '/dictionaries/webster/webster.ifo': text('bookname=Webster’s Revised Unabridged 1913\nwordcount=102217'),
        '/dictionaries/webster/webster.qidx': text('sidecar'),
        '/dictionaries/fr-en/fr-en.idx': text('i'),
        '/dictionaries/fr-en/fr-en.dict': new Blob([new Uint8Array(820_000)]),
        '/.fonts/Literata/Literata_12.cpfont': new Blob([new Uint8Array(120_000)]),
        '/.fonts/Literata/Literata_14.cpfont': new Blob([new Uint8Array(150_000)]),
        '/.fonts/Literata/Literata_16.cpfont': new Blob([new Uint8Array(180_000)]),
        '/fonts/Bookerly/Bookerly-Regular.ttf': new Blob([new Uint8Array(400_000)]),
      },
    }),
  );
  return fake.reader;
}

const meta = {
  title: 'Plugins/CrossPoint tools',
  decorators: [
    (Story) => (
      <Modal title="On X4" onClose={() => undefined}>
        <Story />
      </Modal>
    ),
  ],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Two images in /.sleep; the sleep screen is set to Dark, so the tool offers to switch it. Add pictures to try converting. */
export const SleepImagesTab: Story = {
  render: function SampleSleepImages() {
    return <SleepImages reader={useSampleReader()} profile="X4" />;
  },
};

/** Two dictionaries; add a StarDict zip, tar.gz, folder or loose files. */
export const DictionariesTab: Story = {
  render: function SampleDictionaries() {
    return <Dictionaries reader={useSampleReader()} />;
  },
};

/** Built-in fonts, a .cpfont family and a TTF family; Use switches the reader to one. */
export const FontsTab: Story = {
  render: function SampleFonts() {
    return <Fonts reader={useSampleReader()} />;
  },
};

/** A reader with nothing on it yet. */
export const Empty: Story = {
  render: function EmptyReader() {
    const [{ reader }] = useState(() => fakeReader({ delay: 150 }));
    return (
      <>
        <SleepImages reader={reader} profile="X3" />
        <Dictionaries reader={reader} />
      </>
    );
  },
};
