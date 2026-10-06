import { lazy, Suspense } from 'react';
import type { Plugin } from '../../devices/types';
import { GraphIcon } from '../../components/icons';
import type { CollectionProps } from '../../components/LibraryGrid';

// three.js is large, so the graph loads only when it's shown.
const ForceGraph = lazy(() => import('./ForceGraph'));

function GraphView(props: CollectionProps) {
  return (
    <Suspense fallback={null}>
      <ForceGraph {...props} />
    </Suspense>
  );
}

/** The library as a force graph: books joined by their authors, tags and series. */
export const graph: Plugin = {
  id: 'graph',
  name: 'Graph',
  connectionTypes: [],
  views: [{ id: 'graph.force', label: 'Graph', icon: <GraphIcon />, component: GraphView }],
};
