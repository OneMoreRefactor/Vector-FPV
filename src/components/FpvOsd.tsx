import React from 'react';
import { FLIGHT_MODEL_PRESETS, PHYSICS_BACKEND_META, TelemetrySnapshot } from '../sim/types';

interface FpvOsdProps {
  telemetry: TelemetrySnapshot;
  cameraTiltDeg: number;
  viewMode: 'FPV' | 'CHASE';
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatLap(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const tenth = Math.floor((sec % 1) * 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${tenth}`;
}

function compassLabel(deg: number): string {
  const dirs = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

export const FpvOsd: React.FC<FpvOsdProps> = ({ telemetry, cameraTiltDeg, viewMode }) => {
  const isLowBatt = telemetry.voltagePerCell < 3.55;
  const isCritBatt = telemetry.voltagePerCell < 3.4;

  return (
    <div className="pointer-events-none fixed inset-0 z-10 overflow-hidden select-none">
      {/* Minimal Center Aim Dot (FPV Mode only, no artificial horizon) */}
      {viewMode === 'FPV' && (
        <div
          className="absolute left-1/2 top-1/2 h-1.5 w-1.5 rounded-full bg-white/80 shadow"
          style={{ transform: 'translate(-50%, -50%)', boxShadow: '0 0 3px rgba(0,0,0,0.9)' }}
          aria-hidden="true"
        />
      )}

      {/* Top-Center Compact Compass Heading */}
      <div
        className="font-mono-tech absolute top-3 left-1/2 -translate-x-1/2 text-xs font-semibold text-zinc-100"
        style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}
      >
        {String(Math.round(telemetry.headingDeg)).padStart(3, '0')}° {compassLabel(telemetry.headingDeg)}
      </div>

      {/* Top-Left OSD Block: Flight State, Mode, Throttle, Wind */}
      <div
        className="absolute top-3 left-4 flex flex-col gap-0.5 text-zinc-100"
        style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}
      >
        <div className="flex items-baseline gap-2.5">
          <span className="font-display text-sm font-bold tracking-wider text-amber-400">VEKTOR FPV</span>
          <span className="text-xs text-zinc-400">·</span>
          <span className="font-mono-tech text-xs font-semibold text-white">
            {telemetry.flightMode}
          </span>
          <span className="text-xs text-zinc-400">·</span>
          <span
            className={`font-mono-tech text-xs font-semibold ${
              telemetry.armed ? 'text-cyan-300' : 'text-amber-300'
            }`}
          >
            {telemetry.armed ? 'ARMED' : 'DISARMED'}
          </span>
        </div>

        <div className="font-mono-tech flex items-center gap-3 text-xs text-zinc-200">
          <span>THR {String(telemetry.throttlePct).padStart(3, ' ')}%</span>
          <span className="text-zinc-500">/</span>
          <span>
            WIND {telemetry.windSpeedMs.toFixed(1)} m/s {compassLabel(telemetry.windDirDeg)}
          </span>
        </div>

        <div className="font-mono-tech text-[11px] text-zinc-300/90">
          {telemetry.gamepadConnected
            ? `RC: ${telemetry.gamepadName.slice(0, 28)}`
            : telemetry.controlSource === 'touch'
            ? 'STEUERUNG: TOUCH MODE 2'
            : 'STEUERUNG: TASTATUR / TOUCH'}
        </div>
      </div>

      {/* Top-Right OSD Block: Course Gate, Lap Time, Camera Tilt, FPS */}
      <div
        className="absolute top-3 right-4 flex flex-col items-end gap-0.5 text-right text-zinc-100"
        style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}
      >
        <div className="font-mono-tech flex items-baseline gap-2.5 text-xs font-semibold">
          <span className="text-amber-400">
            TOR {telemetry.activeGateIndex + 1}/{telemetry.totalGates}
          </span>
          <span className="text-zinc-500">·</span>
          <span>RUNDE {telemetry.lapCount + 1}</span>
          <span className="text-zinc-500">·</span>
          <span>{formatLap(telemetry.currentLapSec)}</span>
        </div>
        <div className="font-mono-tech flex items-center gap-2.5 text-[11px] text-zinc-200">
          {telemetry.bestLapSec !== null && (
            <>
              <span className="text-cyan-300">BEST {formatLap(telemetry.bestLapSec)}</span>
              <span className="text-zinc-500">/</span>
            </>
          )}
          <span className="text-zinc-300">
            {telemetry.activeFlightModel === 'custom'
              ? 'CUSTOM'
              : FLIGHT_MODEL_PRESETS[telemetry.activeFlightModel].shortLabel}{' '}
            · {PHYSICS_BACKEND_META[telemetry.activeBackend].shortLabel}
          </span>
          <span className="text-zinc-500">/</span>
          <span>TILT {cameraTiltDeg}°</span>
          <span className="text-zinc-500">/</span>
          <span>{telemetry.fps} FPS</span>
        </div>
      </div>

      {/* Left Mid-Lower OSD: 6S LiPo Battery & Current Telemetry */}
      <div
        className="absolute left-4 top-20 flex flex-col gap-0.5 text-zinc-100 sm:top-24"
        style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}
      >
        <div className="font-mono-tech flex items-baseline gap-2">
          <span
            className={`text-lg font-bold leading-none ${
              isCritBatt ? 'text-red-400' : isLowBatt ? 'text-amber-400' : 'text-white'
            }`}
          >
            {telemetry.voltageTotal.toFixed(1)}V
          </span>
          <span className="text-xs text-zinc-300">
            ({telemetry.voltagePerCell.toFixed(2)}V/Z)
          </span>
        </div>

        {/* Crisp mini LiPo bar */}
        <div className="my-0.5 h-1.5 w-28 overflow-hidden border border-white/20 bg-zinc-900/80">
          <div
            className={`h-full transition-all duration-150 ${
              isCritBatt ? 'bg-red-500' : isLowBatt ? 'bg-amber-400' : 'bg-cyan-400'
            }`}
            style={{ width: `${telemetry.batteryPct}%` }}
          />
        </div>

        <div className="font-mono-tech flex items-center gap-2 text-[11px] text-zinc-200">
          <span>{telemetry.currentA.toFixed(1)} A</span>
          <span className="text-zinc-500">·</span>
          <span>{Math.round(telemetry.mahUsed)} mAh</span>
          <span className="text-zinc-500">·</span>
          <span>{formatTime(telemetry.flightTimeSec)}</span>
        </div>

        {telemetry.voltageSagV > 0.7 && (
          <div className="font-mono-tech text-[10px] font-medium text-amber-300">
            SAG -{telemetry.voltageSagV.toFixed(2)}V
          </div>
        )}
        {isCritBatt && (
          <div className="font-mono-tech text-[11px] font-bold text-red-400">
            AKKU KRITISCH · LANDEN
          </div>
        )}
      </div>

      {/* Right Mid-Lower OSD: Speed, Altitude, Climb Rate, Aero Status */}
      <div
        className="absolute right-4 top-20 flex flex-col items-end gap-0.5 text-right text-zinc-100 sm:top-24"
        style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}
      >
        <div className="font-mono-tech flex items-baseline gap-1.5">
          <span className="text-xl font-bold leading-none text-white">
            {Math.round(telemetry.speedKmh)}
          </span>
          <span className="text-xs text-zinc-300">km/h</span>
        </div>
        <div className="font-mono-tech flex items-center gap-2 text-xs text-zinc-200">
          <span>ALT {telemetry.altitudeM.toFixed(1)} m</span>
          <span className="text-zinc-500">·</span>
          <span>
            {telemetry.verticalSpeedMs >= 0 ? '+' : ''}
            {telemetry.verticalSpeedMs.toFixed(1)} m/s
          </span>
        </div>

        {telemetry.propWashIntensity > 0.28 && (
          <div className="font-mono-tech text-[11px] font-semibold text-amber-400">
            PROP-WASH {Math.round(telemetry.propWashIntensity * 100)}%
          </div>
        )}
        {telemetry.groundEffectFactor > 1.05 && telemetry.armed && (
          <div className="font-mono-tech text-[10px] text-cyan-300">
            BODENEFFEKT +{Math.round((telemetry.groundEffectFactor - 1) * 100)}%
          </div>
        )}
      </div>

      {/* Center Status Notice when Disarmed */}
      {!telemetry.armed && (
        <div className="absolute left-1/2 top-[26%] -translate-x-1/2 text-center">
          <div
            className="font-display text-sm font-semibold tracking-widest text-amber-300"
            style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}
          >
            DISARMED — ARM ZUM STARTEN
          </div>
          <div
            className="mt-1 text-xs text-zinc-200"
            style={{ textShadow: '0 1px 4px rgba(0,0,0,0.95)' }}
          >
            {telemetry.gamepadConnected
              ? 'Arm-Schalter betätigen oder ARM-Taste drücken'
              : 'ARM-Taste unten oder Leertaste drücken · Touch-Sticks oder W/S/A/D + Pfeiltasten'}
          </div>
        </div>
      )}
    </div>
  );
};
