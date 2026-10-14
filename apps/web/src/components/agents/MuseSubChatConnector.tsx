import { useLayoutEffect, useState, type RefObject } from "react";

import { observeResize } from "~/lib/observeResize";

import { museConnectorGeometry, type MuseConnectorGeometry } from "./museSubChatList";

/**
 * One continuous stroke from the avatar's bottom-centre to the open side chat's text. It measures
 * the real avatar and label so it stays correct at any sidebar width.
 */
export function MuseSubChatConnector({
  containerRef,
  avatarRef,
  targetRef,
}: {
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly avatarRef: RefObject<HTMLElement | null>;
  readonly targetRef: RefObject<HTMLElement | null>;
}) {
  const [shape, setShape] = useState<{
    readonly left: number;
    readonly top: number;
    readonly geometry: MuseConnectorGeometry;
  } | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const avatar = avatarRef.current?.getBoundingClientRect();
      const target = targetRef.current?.getBoundingClientRect();
      if (!avatar || !target) return;
      const origin = container.getBoundingClientRect();
      const left = avatar.left + avatar.width / 2 - origin.left;
      const top = avatar.bottom - origin.top;
      const geometry = museConnectorGeometry({
        dy: target.top + target.height / 2 - origin.top - top,
        dx: target.left - origin.left - left - 4,
      });
      setShape((current) =>
        current &&
        current.left === left &&
        current.top === top &&
        current.geometry.path === geometry.path
          ? current
          : { left, top, geometry },
      );
    };
    measure();
    return observeResize(container, measure);
  }, [avatarRef, containerRef, targetRef]);

  if (!shape) return null;
  const { geometry } = shape;
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute z-0 overflow-visible"
      style={{ left: shape.left, top: shape.top }}
      width={geometry.width}
      height={geometry.height}
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      fill="none"
    >
      <path
        d={geometry.path}
        stroke="var(--muted-foreground)"
        strokeWidth={1.25}
        strokeLinecap="round"
      />
    </svg>
  );
}
