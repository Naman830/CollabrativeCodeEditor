// Inline SVGs for the toolbar, the room chrome and the profile pages. Kept here
// rather than pulled from an icon package: a handful of paths do not justify a
// dependency, and every one is `aria-hidden` because the button it sits in
// already carries the label.
//
// Every icon takes an optional `className` and defaults to `h-3.5 w-3.5`, so
// callers that pass nothing keep the size they had before the redesign.

type IconProps = { className?: string };

/** Shared wrapper for the stroked icons — the majority. */
function Stroke({
  className = "h-3.5 w-3.5",
  width = 2,
  children,
}: IconProps & { width?: number; children: React.ReactNode }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {children}
    </svg>
  );
}

export function PlayIcon({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}

export function DownloadIcon({ className }: IconProps = {}) {
  return (
    <Stroke className={className}>
      <path d="M12 4v11" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 19h14" />
    </Stroke>
  );
}

export function CopyIcon({ className }: IconProps = {}) {
  return (
    <Stroke className={className}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </Stroke>
  );
}

export function CheckIcon({ className }: IconProps = {}) {
  return (
    <Stroke className={className}>
      <path d="m5 13 4 4 10-10" />
    </Stroke>
  );
}

/**
 * The padlock `RoomGate` draws on its "this room has closed" screen, shared with
 * /profile. One shape for one meaning: a room that no longer exists.
 */
export function LockIcon({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <Stroke className={className}>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </Stroke>
  );
}

export function ArrowLeftIcon({ className }: IconProps = {}) {
  return (
    <Stroke className={className}>
      <path d="M19 12H5" />
      <path d="m11 6-6 6 6 6" />
    </Stroke>
  );
}

/** The saved-snapshot glyph: a page, for a room that is now just a file. */
export function ArchiveIcon({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </Stroke>
  );
}

/* -------------------------------------------------------------------------- */
/* Theme toggle                                                                */
/* -------------------------------------------------------------------------- */

export function SunIcon({ className }: IconProps = {}) {
  return (
    <Stroke className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Stroke>
  );
}

export function MoonIcon({ className }: IconProps = {}) {
  return (
    <Stroke className={className}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
    </Stroke>
  );
}

export function MonitorIcon({ className }: IconProps = {}) {
  return (
    <Stroke className={className}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </Stroke>
  );
}

/* -------------------------------------------------------------------------- */
/* Room chrome                                                                 */
/* -------------------------------------------------------------------------- */

/** The product mark: the `</>` chevrons used on the landing page and room bar. */
export function LogoMark({ className = "h-4 w-4" }: IconProps) {
  return (
    <Stroke className={className} width={2.2}>
      <path d="m9 8-4 4 4 4" />
      <path d="m15 8 4 4-4 4" />
    </Stroke>
  );
}

export function ChevronDownIcon({ className }: IconProps = {}) {
  return (
    <Stroke className={className}>
      <path d="m6 9 6 6 6-6" />
    </Stroke>
  );
}

/** Swap the editor/output split between side-by-side and stacked. */
export function SplitIcon({ className }: IconProps = {}) {
  return (
    <Stroke className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </Stroke>
  );
}

export function TerminalIcon({ className }: IconProps = {}) {
  return (
    <Stroke className={className}>
      <path d="m5 7 4 4-4 4" />
      <path d="M13 15h6" />
    </Stroke>
  );
}

export function FileCodeIcon({ className }: IconProps = {}) {
  return (
    <Stroke className={className}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="m10 12-2 2 2 2M14 12l2 2-2 2" />
    </Stroke>
  );
}

/* -------------------------------------------------------------------------- */
/* Landing and error pages                                                     */
/* -------------------------------------------------------------------------- */

export function CursorIcon({ className }: IconProps = {}) {
  return (
    <Stroke className={className}>
      <path d="m4 3 6.5 17 2.5-7 7-2.5z" />
    </Stroke>
  );
}

export function ShieldIcon({ className }: IconProps = {}) {
  return (
    <Stroke className={className}>
      <path d="M12 3 5 6v6c0 4.2 2.9 7.9 7 9 4.1-1.1 7-4.8 7-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </Stroke>
  );
}

export function BoltIcon({ className }: IconProps = {}) {
  return (
    <Stroke className={className}>
      <path d="M13 3 5 14h6l-1 7 8-11h-6z" />
    </Stroke>
  );
}

export function SearchIcon({ className }: IconProps = {}) {
  return (
    <Stroke className={className}>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-3.5-3.5" />
    </Stroke>
  );
}

export function AlertIcon({ className }: IconProps = {}) {
  return (
    <Stroke className={className}>
      <path d="M12 4 2.5 20h19z" />
      <path d="M12 10v4M12 17.5h.01" />
    </Stroke>
  );
}

export function TrashIcon({ className }: IconProps = {}) {
  return (
    <Stroke className={className}>
      <path d="M4 7h16" />
      <path d="M9.5 7V5h5v2" />
      <path d="M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7" />
      <path d="M10.5 11v6M13.5 11v6" />
    </Stroke>
  );
}

export function WifiOffIcon({ className }: IconProps = {}) {
  return (
    <Stroke className={className}>
      <path d="M5 12.5a7 7 0 0 1 14 0" />
      <path d="M8.5 15.5a3.5 3.5 0 0 1 7 0" />
      <path d="M12 19h.01" />
      <path d="m4 4 16 16" />
    </Stroke>
  );
}

export function UserIcon({ className }: IconProps = {}) {
  return (
    <Stroke className={className} width={1.8}>
      <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </Stroke>
  );
}

export function UsersIcon({ className }: IconProps = {}) {
  return (
    <Stroke className={className}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.5a3 3 0 0 1 0 5.8M17.5 19a5.5 5.5 0 0 0-2-4.2" />
    </Stroke>
  );
}
