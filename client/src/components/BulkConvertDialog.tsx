import type { Item } from '@nexlibris/common';
import { useState } from 'react';
import styled from 'styled-components';
import type { FormatId } from '../formats/formats';
import { conversionSource, convertItemFile } from '../library/convert';
import { useLibrary } from '../library/LibraryContext';
import { Button, Muted, Row, Spacer, Stack } from '../styles/ui';
import { formatLabel } from './ItemFiles';
import { Modal, ModalFooter } from './Modal';

const ErrorText = styled.p`
  color: var(--danger);
`;

const CONVERSION_TARGETS: FormatId[] = ['epub', 'cbz', 'txt'];

interface Props {
  items: Item[];
  onClose(): void;
}

/** Converts the selected books to a format, each book that can be (and lacks it) in turn. */
export function BulkConvertDialog({ items, onClose }: Props) {
  const { backend, apply } = useLibrary();
  const [progress, setProgress] = useState<string>();
  const [failures, setFailures] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const count = items.length;

  const targets = CONVERSION_TARGETS.map((to) => ({
    to,
    sources: items.flatMap((item) => {
      const source = conversionSource(item, to);
      return source ? [{ item, ...source }] : [];
    }),
  }));

  const convertAll = async (to: FormatId) => {
    const sources = targets.find((t) => t.to === to)?.sources ?? [];
    const failed: string[] = [];
    setRunning(true);
    setFailures([]);
    for (const [n, { item, file, converter }] of sources.entries()) {
      setProgress(`Converting ${n + 1} of ${sources.length} to ${formatLabel(to)}…`);
      try {
        await apply([await convertItemFile(backend, item, file, converter)]);
      } catch (e) {
        failed.push(`${item.title}: ${e instanceof Error ? e.message : e}`);
      }
    }
    setRunning(false);
    setFailures(failed);
    setProgress(`Converted ${sources.length - failed.length} to ${formatLabel(to)}.`);
  };

  return (
    <Modal title={`Convert ${count} book${count === 1 ? '' : 's'}`} onClose={() => !running && onClose()}>
      <Muted as="p">Each book that lacks the format, and has a file to make it from, gets a copy in it.</Muted>
      <Stack>
        {targets.map(({ to, sources }) => (
          <Row key={to}>
            <span>
              {formatLabel(to)}{' '}
              <Muted>({sources.length === 0 ? 'none' : sources.length === count ? 'all' : `${sources.length} of ${count}`})</Muted>
            </span>
            <Spacer />
            <Button $variant="secondary" $size="small" disabled={running || sources.length === 0} onClick={() => void convertAll(to)}>
              Make {formatLabel(to)}
            </Button>
          </Row>
        ))}
      </Stack>
      {progress && (
        <Muted as="p" role="status">
          {progress}
        </Muted>
      )}
      {failures.length > 0 && (
        <ErrorText>
          {failures.length} failed: {failures.join('; ')}
        </ErrorText>
      )}
      <ModalFooter>
        <Spacer />
        <Button disabled={running} onClick={onClose}>
          Done
        </Button>
      </ModalFooter>
    </Modal>
  );
}
