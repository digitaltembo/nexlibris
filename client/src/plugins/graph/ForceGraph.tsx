import ForceGraph3D, { type ForceGraph3DInstance, type LinkObject, type NodeObject } from '3d-force-graph';
import { useEffect, useMemo, useRef } from 'react';
import styled from 'styled-components';
import { Color, Vector2 } from 'three';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { CollectionProps } from '../../components/LibraryGrid';
import { isDark, onAppearanceChange } from '../../styles/appearance';
import { booksOf, buildGraph, endId, type GraphLink, type GraphNode } from './graph';

/**
 * The books as stars in a 3D force graph, as on the readings site: books drawn together by the
 * authors, tags and series they share (`graph.ts`). Hover a node to see what it joins; click a book
 * to fly to it and open it (Cmd/Ctrl- and Shift-click select, as in the grid); click an author, tag
 * or series to light up its books and zoom to them; click the background to see everything again.
 * In the theme's colours: a night sky with a glow in the dark scheme, ink on paper in the light one,
 * following a light or dark picked in Settings as well as the system.
 */

type Node = GraphNode & NodeObject;
type Link = Omit<GraphLink, 'source' | 'target'> & LinkObject<Node>;

/** The theme's colours, read from its CSS variables, so the graph follows the scheme. */
interface Palette {
  dark: boolean;
  background: string;
  book: string;
  selected: string;
  author: string;
  tag: string;
  series: string;
  link: string;
  lit: string;
}

function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    dark: isDark(),
    background: v('--bg', '#071f37'),
    book: v('--text', '#faf0ca'),
    selected: v('--danger', '#ff6847'),
    author: v('--highlight', '#ee964b'),
    tag: v('--star', '#f4d35e'),
    series: v('--muted', '#a9b3a9'),
    link: v('--muted', '#a9b3a9'),
    lit: v('--highlight', '#ee964b'),
  };
}

/** How far from a book the camera stops when flying to it. */
const FLY_DISTANCE = 140;

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const KIND_LABEL = { author: 'author', tag: 'tag', series: 'series' } as const;

/** A node's tooltip, built from text so book titles can't add markup. */
function tooltip(node: Node): HTMLElement {
  const el = document.createElement('div');
  const title = el.appendChild(document.createElement('strong'));
  title.textContent = node.label;
  const line = (text: string) => (el.appendChild(document.createElement('div')).textContent = text);
  if (node.kind === 'book') {
    if (node.detail) line(`by ${node.detail}`);
  } else {
    line(`${KIND_LABEL[node.kind]} · ${node.books} ${node.books === 1 ? 'book' : 'books'}`);
  }
  return el;
}

export function ForceGraph({ items, selection, onActivate }: CollectionProps) {
  const container = useRef<HTMLDivElement>(null);
  const graph = useRef<ForceGraph3DInstance<Node, Link>>(undefined);
  const data = useMemo(() => buildGraph(items), [items]);
  // What the graph's callbacks read, kept current without rebuilding it.
  const state = useRef({ data, selection, onActivate, hovered: undefined as Node | undefined, pinned: undefined as Node | undefined });
  state.current.data = data;
  state.current.selection = selection;
  state.current.onActivate = onActivate;

  // The graph itself, made once.
  useEffect(() => {
    const el = container.current!;
    let palette = readPalette();
    // Only what's brighter than the navy background glows (the readings site's is near black, so its threshold is 0).
    const bloom = new UnrealBloomPass(new Vector2(el.clientWidth, el.clientHeight), 0.9, 0.6, 0.35);
    // The glow works in linear colour, so the page's colours come back after it; without it, the scene goes straight out.
    const output = new OutputPass();
    const fg = new ForceGraph3D(el, { controlType: 'orbit' }) as unknown as ForceGraph3DInstance<Node, Link>;
    graph.current = fg;

    const focus = () => state.current.hovered ?? state.current.pinned;
    const touches = (link: Link, node: Node) => endId(link.source as string) === node.id || endId(link.target as string) === node.id;
    const colorOf = (node: Node) => {
      if (node.kind === 'book') return state.current.selection.has(node.id) ? palette.selected : palette.book;
      return palette[node.kind];
    };
    const sizeOf = (node: Node) => {
      if (node.kind === 'book') return state.current.selection.has(node.id) ? 6 : 1.2;
      return 1 + Math.sqrt(node.books) * 1.5;
    };
    /** Only the focused node's links, lit; otherwise all of them, faint. */
    const showLinks = () => {
      const node = focus();
      fg.linkVisibility(node ? (link) => touches(link, node) : true)
        .linkWidth(node ? 1.2 : 0)
        .linkColor(node ? () => palette.lit : () => palette.link)
        .linkOpacity(node ? 0.9 : palette.dark ? 0.18 : 0.3);
    };
    const theme = () => {
      fg.backgroundColor(palette.background).nodeColor(colorOf);
      bloom.enabled = output.enabled = palette.dark;
      // Through the glow, the renderer's clear colour comes out paler than it is; the scene's background doesn't.
      fg.scene().background = palette.dark ? new Color(palette.background) : null;
      showLinks();
    };

    fg.width(el.clientWidth)
      .height(el.clientHeight)
      .showNavInfo(false)
      .nodeId('id')
      .nodeVal(sizeOf)
      .nodeLabel(tooltip)
      .nodeResolution(16)
      .nodeOpacity(0.95)
      .warmupTicks(60)
      .cooldownTime(8000)
      .onNodeHover((node) => {
        state.current.hovered = node ?? undefined;
        el.style.cursor = node ? 'pointer' : '';
        showLinks();
      })
      .onNodeClick((node, event) => {
        if (node.kind !== 'book') {
          state.current.pinned = node;
          showLinks();
          const books = booksOf(state.current.data, node.id);
          books.add(node.id);
          fg.zoomToFit(reducedMotion() ? 0 : 800, 40, (n) => books.has(n.id));
          return;
        }
        const modifiers = { shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey };
        state.current.onActivate(node.id, modifiers);
        if (modifiers.shiftKey || modifiers.metaKey || modifiers.ctrlKey) return;
        // Fly to the book, looking at it from outside, as the readings site does.
        const { x = 0, y = 0, z = 0 } = node;
        const ratio = 1 + FLY_DISTANCE / (Math.hypot(x, y, z) || 1);
        fg.cameraPosition({ x: x * ratio, y: y * ratio, z: z * ratio || FLY_DISTANCE }, { x, y, z }, reducedMotion() ? 0 : 1200);
      })
      .onBackgroundClick(() => {
        state.current.pinned = undefined;
        showLinks();
        fg.zoomToFit(reducedMotion() ? 0 : 800, 20);
      });
    fg.postProcessingComposer().addPass(bloom);
    fg.postProcessingComposer().addPass(output);
    theme();
    // Once the first layout has settled, frame the whole graph.
    let framed = false;
    fg.onEngineStop(() => {
      // It stops once before the books are given it, with nothing to frame.
      if (framed || !fg.graphData().nodes.length) return;
      framed = true;
      fg.zoomToFit(reducedMotion() ? 0 : 600, 20);
    });

    const resize = new ResizeObserver(() => {
      fg.width(el.clientWidth).height(el.clientHeight);
      bloom.setSize(el.clientWidth, el.clientHeight);
    });
    resize.observe(el);
    const stopFollowing = onAppearanceChange(() => {
      palette = readPalette();
      theme();
    });
    return () => {
      stopFollowing();
      resize.disconnect();
      fg._destructor();
      el.replaceChildren();
      graph.current = undefined;
    };
  }, []);

  // The books shown: nodes that stay keep their place, so a search or an edit doesn't scatter them.
  useEffect(() => {
    const fg = graph.current;
    if (!fg) return;
    const placed = new Map(fg.graphData().nodes.map((n) => [n.id, n]));
    const nodes = data.nodes.map((node) => Object.assign(placed.get(node.id) ?? {}, node) as Node);
    const links = data.links.map((link) => ({ ...link }) as Link);
    const pinned = state.current.pinned;
    if (pinned && !nodes.some((n) => n.id === pinned.id)) state.current.pinned = undefined;
    fg.graphData({ nodes, links });
  }, [data]);

  // Selected books stand out; the accessors read the selection, so asking again redraws them.
  useEffect(() => {
    const fg = graph.current;
    if (!fg) return;
    fg.nodeColor(fg.nodeColor()).nodeVal(fg.nodeVal());
  }, [selection]);

  return <Canvas ref={container} role="img" aria-label={`A graph of ${items.length} books, joined by their authors, tags and series`} />;
}

export default ForceGraph;

const Canvas = styled.div`
  position: relative;
  /* The rest of the window below the header, less the page's padding. */
  height: calc(100dvh - var(--header-height, 0px) - 32px);
  min-height: 320px;
  overflow: hidden;
  border-radius: var(--radius);
  background: var(--bg);

  .float-tooltip-kap {
    max-width: 280px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 0.9em;
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.2);
  }
`;
