"use client";

import { useCallback } from "react";

import { cx } from "../ui";

/** Mirrored self-view. Display only — analysis runs on the engine's own video element. */
export function CameraPreview({ stream, className, children }: { stream: MediaStream; className?: string; children?: React.ReactNode }) {
  const attach = useCallback(
    (video: HTMLVideoElement | null) => {
      if (video && video.srcObject !== stream) {
        video.srcObject = stream;
        void video.play().catch(() => undefined);
      }
    },
    [stream],
  );
  return (
    <div className={cx("relative overflow-hidden rounded-xl bg-black", className)}>
      <video ref={attach} muted playsInline autoPlay data-proctor-owned className="block aspect-[4/3] w-full -scale-x-100 object-cover" />
      {children}
    </div>
  );
}
