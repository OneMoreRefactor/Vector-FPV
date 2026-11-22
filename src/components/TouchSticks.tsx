import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ControlInputs } from '../sim/types';

interface TouchSticksProps {
  visible: boolean;
  resetSignal: number;
  onChange: (sticks: ControlInputs) => void;
  onActiveInteraction: () => void;
}

/**
 * Multi-Touch Mode 2 On-Screen Virtual Gimbals for iPad Air Safari
 * - Larger iPad-ergonomic 208px–256px gimbal rings
 * - Pixel-exact centering via percentage left/top + single translate(-50%, -50%)
 * - Left Gimbal: Throttle (non-centering vertical 0..1) + Yaw (spring-centering horizontal -1..1)
 * - Right Gimbal: Pitch (spring-centering vertical -1..1) + Roll (spring-centering horizontal -1..1)
 */
export const TouchSticks: React.FC<TouchSticksProps> = ({
  visible,
  resetSignal,
  onChange,
  onActiveInteraction,
}) => {
  const sticksRef = useRef<ControlInputs>({ throttle: 0, yaw: 0, pitch: 0, roll: 0 });
  const [uiPos, setUiPos] = useState({
    leftX: 0,
    leftY: 1, // +1 = bottom (0% throttle), 0 = center (50% throttle), -1 = top (100% throttle)
    rightX: 0,
    rightY: 0, // Dead-center neutral
  });

  useEffect(() => {
    if (resetSignal === 0) return;
    sticksRef.current = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
    setUiPos({ leftX: 0, leftY: 1, rightX: 0, rightY: 0 });
    onChange({ throttle: 0, yaw: 0, pitch: 0, roll: 0 });
  }, [resetSignal, onChange]);

  const leftPadRef = useRef<HTMLDivElement>(null);
  const rightPadRef = useRef<HTMLDivElement>(null);
  const leftPointerId = useRef<number | null>(null);
  const rightPointerId = useRef<number | null>(null);

  // Max knob travel as fraction of outer gimbal diameter (37% keeps knob cleanly inside ring)
  const TRAVEL_PCT = 37;

  const emit = useCallback(() => {
    onChange({ ...sticksRef.current });
  }, [onChange]);

  const updateLeftFromClient = useCallback(
    (clientX: number, clientY: number) => {
      const el = leftPadRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const radius = rect.width * (TRAVEL_PCT / 100);
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      const nx = Math.max(-1, Math.min(1, (clientX - cx) / radius));
      const ny = Math.max(-1, Math.min(1, (clientY - cy) / radius));

      // Throttle: bottom (+1) = 0, top (-1) = 1
      let throttle = (1 - ny) * 0.5;
      if (throttle < 0.03) throttle = 0;

      sticksRef.current.throttle = throttle;
      sticksRef.current.yaw = Math.abs(nx) < 0.04 ? 0 : nx;
      setUiPos((prev) => ({ ...prev, leftX: nx, leftY: 1 - throttle * 2 }));
      emit();
    },
    [emit]
  );

  const updateRightFromClient = useCallback(
    (clientX: number, clientY: number) => {
      const el = rightPadRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const radius = rect.width * (TRAVEL_PCT / 100);
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      let nx = (clientX - cx) / radius;
      let ny = (clientY - cy) / radius;
      const len = Math.hypot(nx, ny);
      if (len > 1) {
        nx /= len;
        ny /= len;
      }

      // Pitch up on screen (-ny) => pitch forward (+1)
      sticksRef.current.roll = Math.abs(nx) < 0.035 ? 0 : nx;
      sticksRef.current.pitch = Math.abs(ny) < 0.035 ? 0 : -ny;
      setUiPos((prev) => ({ ...prev, rightX: nx, rightY: ny }));
      emit();
    },
    [emit]
  );

  const handleLeftDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    onActiveInteraction();
    leftPointerId.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    updateLeftFromClient(e.clientX, e.clientY);
  };

  const handleLeftMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (leftPointerId.current !== e.pointerId) return;
    e.preventDefault();
    updateLeftFromClient(e.clientX, e.clientY);
  };

  const handleLeftUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (leftPointerId.current !== e.pointerId) return;
    leftPointerId.current = null;
    // Yaw springs to exact center; Throttle holds position like a real Mode-2 RC gimbal
    sticksRef.current.yaw = 0;
    setUiPos((prev) => ({ ...prev, leftX: 0 }));
    emit();
  };

  const handleRightDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    onActiveInteraction();
    rightPointerId.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    updateRightFromClient(e.clientX, e.clientY);
  };

  const handleRightMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (rightPointerId.current !== e.pointerId) return;
    e.preventDefault();
    updateRightFromClient(e.clientX, e.clientY);
  };

  const handleRightUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (rightPointerId.current !== e.pointerId) return;
    rightPointerId.current = null;
    sticksRef.current.roll = 0;
    sticksRef.current.pitch = 0;
    setUiPos((prev) => ({ ...prev, rightX: 0, rightY: 0 }));
    emit();
  };

  if (!visible) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-20 flex items-end justify-between px-4 sm:bottom-6 sm:px-7">
      {/* Left Mode-2 Gimbal: Throttle + Yaw */}
      <div className="flex flex-col items-center gap-1.5">
        <div
          ref={leftPadRef}
          onPointerDown={handleLeftDown}
          onPointerMove={handleLeftMove}
          onPointerUp={handleLeftUp}
          onPointerCancel={handleLeftUp}
          style={{ touchAction: 'none' }}
          className="pointer-events-auto relative h-52 w-52 rounded-full border-2 border-white/25 bg-zinc-950/45 shadow-xl sm:h-60 sm:w-60 lg:h-64 lg:w-64"
          aria-label="Linker Stick: Throttle und Yaw"
        >
          {/* Precision Crosshair & Travel Guides */}
          <div className="pointer-events-none absolute inset-x-5 top-1/2 h-px -translate-y-1/2 bg-white/18" />
          <div className="pointer-events-none absolute inset-y-5 left-1/2 w-px -translate-x-1/2 bg-white/18" />
          <div className="pointer-events-none absolute inset-6 rounded-full border border-dashed border-white/15" />
          {/* Exact Center Dot */}
          <div
            className="pointer-events-none absolute h-2 w-2 rounded-full bg-white/30"
            style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
          />

          {/* Gimbal Thumb Knob (single transform centering — zero offset drift) */}
          <div
            className="pointer-events-none absolute h-16 w-16 rounded-full border-2 border-amber-400 bg-zinc-900/90 shadow-lg sm:h-[70px] sm:w-[70px]"
            style={{
              left: `${50 + uiPos.leftX * TRAVEL_PCT}%`,
              top: `${50 + uiPos.leftY * TRAVEL_PCT}%`,
              transform: 'translate(-50%, -50%)',
            }}
          >
            <div className="absolute inset-2.5 rounded-full border border-amber-400/50 bg-amber-400/20" />
            <div
              className="absolute h-2.5 w-2.5 rounded-full bg-amber-400"
              style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
            />
          </div>
        </div>
        <span
          className="font-mono-tech text-[11px] font-medium tracking-wider text-zinc-200/85"
          style={{ textShadow: '0 1px 3px rgba(0,0,0,0.9)' }}
        >
          THROTTLE / YAW
        </span>
      </div>

      {/* Right Mode-2 Gimbal: Pitch + Roll */}
      <div className="flex flex-col items-center gap-1.5">
        <div
          ref={rightPadRef}
          onPointerDown={handleRightDown}
          onPointerMove={handleRightMove}
          onPointerUp={handleRightUp}
          onPointerCancel={handleRightUp}
          style={{ touchAction: 'none' }}
          className="pointer-events-auto relative h-52 w-52 rounded-full border-2 border-white/25 bg-zinc-950/45 shadow-xl sm:h-60 sm:w-60 lg:h-64 lg:w-64"
          aria-label="Rechter Stick: Pitch und Roll"
        >
          {/* Precision Crosshair & Travel Guides */}
          <div className="pointer-events-none absolute inset-x-5 top-1/2 h-px -translate-y-1/2 bg-white/18" />
          <div className="pointer-events-none absolute inset-y-5 left-1/2 w-px -translate-x-1/2 bg-white/18" />
          <div className="pointer-events-none absolute inset-6 rounded-full border border-dashed border-white/15" />
          {/* Exact Center Dot */}
          <div
            className="pointer-events-none absolute h-2 w-2 rounded-full bg-white/30"
            style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
          />

          {/* Gimbal Thumb Knob (single transform centering — pixel-exact neutral center) */}
          <div
            className="pointer-events-none absolute h-16 w-16 rounded-full border-2 border-cyan-400 bg-zinc-900/90 shadow-lg sm:h-[70px] sm:w-[70px]"
            style={{
              left: `${50 + uiPos.rightX * TRAVEL_PCT}%`,
              top: `${50 + uiPos.rightY * TRAVEL_PCT}%`,
              transform: 'translate(-50%, -50%)',
            }}
          >
            <div className="absolute inset-2.5 rounded-full border border-cyan-400/50 bg-cyan-400/20" />
            <div
              className="absolute h-2.5 w-2.5 rounded-full bg-cyan-400"
              style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
            />
          </div>
        </div>
        <span
          className="font-mono-tech text-[11px] font-medium tracking-wider text-zinc-200/85"
          style={{ textShadow: '0 1px 3px rgba(0,0,0,0.9)' }}
        >
          PITCH / ROLL
        </span>
      </div>
    </div>
  );
};
