/**
 * Phosphor icons, duotone weight, as the handoff specifies ("Icons: Phosphor,
 * duotone weight. Use the real Phosphor set.").
 *
 * The path data is lifted from @phosphor-icons/web 2.1.2 (MIT) rather than
 * added as a dependency: the browser surface is a static bundle behind a
 * token wall, and two inline components carry no package, no icon font, and
 * no extra request. A duotone icon is two paths - the inner shape at 0.2
 * opacity, the outline solid - coloured by whatever the surrounding chrome
 * sets on `currentColor`.
 */
import type * as React from "react";

const Duotone = ({
  size,
  children,
}: {
  size: number;
  children: React.ReactNode;
}): React.ReactElement => (
  <svg width={size} height={size} viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true">
    {children}
  </svg>
);

export const PencilDuotone = ({ size = 14 }: { size?: number }): React.ReactElement => (
  <Duotone size={size}>
    <path
      opacity="0.2"
      d="M886.64 361.36l-118.64 118.64-224-224 118.64-118.64c5.79-5.786 13.787-9.365 22.62-9.365s16.83 3.579 22.62 9.365l178.76 178.64c5.822 5.796 9.425 13.817 9.425 22.68s-3.603 16.884-9.424 22.679l-0.001 0.001z"
    />
    <path d="M909.24 293.48l-178.72-178.76c-11.582-11.585-27.584-18.75-45.26-18.75s-33.678 7.166-45.26 18.75l-493.24 493.28c-11.587 11.498-18.76 27.43-18.76 45.037 0 0.071 0 0.143 0 0.214l-0-0.011v178.76c0 35.346 28.654 64 64 64v0h178.76c0.060 0 0.131 0 0.203 0 17.607 0 33.539-7.173 45.033-18.756l0.004-0.004 493.24-493.24c11.585-11.582 18.75-27.584 18.75-45.26s-7.166-33.678-18.75-45.26l-0-0zM205.24 640l338.76-338.76 66.76 66.76-338.76 338.72zM192 717.24l114.76 114.76h-114.76zM384 818.76l-66.76-66.76 338.76-338.76 66.76 66.76zM768 434.76l-178.76-178.76 96-96 178.76 178.72z" />
  </Duotone>
);

export const CaretDownDuotone = ({ size = 13 }: { size?: number }): React.ReactElement => (
  <Duotone size={size}>
    <path opacity="0.2" d="M832 384l-320 320-320-320z" />
    <path d="M861.56 371.76c-4.934-11.696-16.306-19.757-29.56-19.76l-640-0c-0.007-0-0.016-0-0.025-0-17.673 0-32 14.327-32 32 0 8.843 3.587 16.848 9.385 22.64l0 0 320 320c5.792 5.798 13.797 9.385 22.64 9.385s16.848-3.587 22.64-9.385l0-0 320-320c5.785-5.79 9.363-13.786 9.363-22.618 0-4.425-0.898-8.639-2.522-12.472l0.079 0.21zM512 658.76l-242.76-242.76h485.52z" />
  </Duotone>
);
