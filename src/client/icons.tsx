/** Inline glyphs (currentColor), sized like the host's 12–16px header icons. */

interface IconProps {
  size?: number;
}

/** Two-prong plug: the MCP connector mark. */
export function PlugIcon({ size = 15 }: IconProps) {
  return (
    <svg className="mcpm-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5.5 1.75v3M10.5 1.75v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M3.75 4.75h8.5v2.5a4.25 4.25 0 0 1-8.5 0v-2.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M8 11.5v2.75" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function ChevronIcon({ size = 12 }: IconProps) {
  return (
    <svg className="mcpm-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function RefreshIcon({ size = 14 }: IconProps) {
  return (
    <svg className="mcpm-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M13.25 2.5v3h-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CloseIcon({ size = 14 }: IconProps) {
  return (
    <svg className="mcpm-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function ExternalIcon({ size = 12 }: IconProps) {
  return (
    <svg className="mcpm-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9 3h4v4M13 3L7.5 8.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function CheckIcon({ size = 10 }: IconProps) {
  return (
    <svg className="mcpm-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
