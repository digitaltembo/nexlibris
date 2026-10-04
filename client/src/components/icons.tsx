/** Line icons, drawn in the text color at the text's size. */

const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg
    viewBox="0 0 24 24"
    width="1.15em"
    height="1.15em"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const MenuIcon = () => (
  <Icon>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Icon>
);

export const FilterIcon = () => (
  <Icon>
    <path d="M3 5h18l-7 8.5V19l-4 2v-7.5z" />
  </Icon>
);

export const SearchIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-4-4" />
  </Icon>
);

export const GridIcon = () => (
  <Icon>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1" />
  </Icon>
);

export const ListIcon = () => (
  <Icon>
    <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />
  </Icon>
);

export const ShelfIcon = () => (
  <Icon>
    <path d="M3 20h18M5 20V6h3v14M10 20V4h3v16M15.5 20l-1.8-12.6 2.9-.4L18.4 19.6" />
  </Icon>
);
