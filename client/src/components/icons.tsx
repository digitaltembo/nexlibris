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

export const GraphIcon = () => (
  <Icon>
    <circle cx="6" cy="7" r="2" />
    <circle cx="17" cy="5" r="2" />
    <circle cx="12" cy="13" r="2.5" />
    <circle cx="5" cy="19" r="1.5" />
    <circle cx="19" cy="17" r="2" />
    <path d="M7.6 8.3l2.7 3M15.6 6.5l-2.4 4.6M10.7 15.2L6.2 18M14.3 14l2.9 2" />
  </Icon>
);

export const ShelfIcon = () => (
  <Icon>
    <path d="M3 20h18M5 20V6h3v14M10 20V4h3v16M15.5 20l-1.8-12.6 2.9-.4L18.4 19.6" />
  </Icon>
);

export const EyeIcon = () => (
  <Icon>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const EditIcon = () => (
  <Icon>
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </Icon>
);
