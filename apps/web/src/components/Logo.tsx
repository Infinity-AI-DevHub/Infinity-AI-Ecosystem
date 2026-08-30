/**
 * The Infinity mark.
 *
 * The same artwork as the application icon (apps/desktop/build/icon.svg), redrawn here
 * as a component so the window, the sign-in screen and the installed app icon are one
 * identity rather than three that drift apart.
 *
 * `tone` picks how it sits on its background: "brand" paints its own tile for light
 * surfaces, "inverse" drops the tile and inherits currentColor, which is what the dark
 * navigation plane needs.
 */
export function Logo({
  size = 34,
  tone = 'brand',
}: {
  size?: number;
  tone?: 'brand' | 'inverse';
}) {
  const mark = (
    <g transform="translate(102.4,52.4) scale(0.6)">
      <path
        d="M256,256 C300,160 420,160 420,256 C420,352 300,352 256,256
           C212,160 92,160 92,256 C92,352 212,352 256,256"
        fill="none"
        stroke={tone === 'brand' ? '#FFFFFF' : 'currentColor'}
        strokeWidth="73.33"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  );

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0 }}
    >
      {tone === 'brand' && (
        <>
          <defs>
            <linearGradient id="iw-tile" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#1A6288" />
              <stop offset=".55" stopColor="#0D4260" />
              <stop offset="1" stopColor="#082D42" />
            </linearGradient>
          </defs>
          <rect width="512" height="512" rx="114.5" fill="url(#iw-tile)" />
        </>
      )}
      {mark}
      <rect
        x="86"
        y="352"
        width="340"
        height="36"
        rx="18"
        fill={tone === 'brand' ? '#8FC3E4' : 'currentColor'}
        opacity={tone === 'brand' ? 1 : 0.55}
      />
    </svg>
  );
}
