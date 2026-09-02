/**
 * The exact desktop application icon, shared by every web surface.
 *
 * It is generated from apps/desktop/build/icon.svg by the desktop icon script, so the
 * app icon, favicon and in-product lockups cannot visually drift apart.
 */
export function Logo({
  size = 34,
  tone = 'brand',
}: {
  size?: number;
  tone?: 'brand' | 'inverse';
}) {
  return (
    <img
      src="/favicon.svg"
      alt=""
      width={size}
      height={size}
      aria-hidden="true"
      className={`product-icon product-icon-${tone}`}
    />
  );
}
