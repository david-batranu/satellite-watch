/** The AR surface: camera feed, WebGL sky and HUD canvas. */

import type { RefObject } from 'react';

export interface ARViewRefs {
  root: RefObject<HTMLDivElement | null>;
  skyCanvas: RefObject<HTMLCanvasElement | null>;
  hudCanvas: RefObject<HTMLCanvasElement | null>;
  video: RefObject<HTMLVideoElement | null>;
}

export function ARView({ refs, cameraActive }: { refs: ARViewRefs; cameraActive: boolean }) {
  return (
    <div className="ar-root" ref={refs.root}>
      <div className="ar-night" aria-hidden="true" />
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={refs.video}
        className={`ar-video ${cameraActive ? 'is-active' : ''}`}
        playsInline
        muted
        autoPlay
        aria-hidden="true"
      />
      <canvas ref={refs.skyCanvas} className="ar-canvas ar-canvas--sky" aria-hidden="true" />
      <canvas ref={refs.hudCanvas} className="ar-canvas ar-canvas--hud" aria-hidden="true" />
      <div className="ar-scrim" aria-hidden="true" />
    </div>
  );
}
