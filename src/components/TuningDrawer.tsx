import React, { useEffect, useRef, useState } from 'react';
import {
  X,
  RotateCcw,
  Sliders,
  Gamepad2,
  Wind,
  Camera,
  Check,
  BatteryCharging,
  Cpu,
  Save,
  Trash2,
  Copy,
  Upload,
} from 'lucide-react';
import {
  CameraViewMode,
  ControllerConfig,
  DEFAULT_SIM_CONFIG,
  FLIGHT_MODEL_PRESETS,
  FlightModelId,
  PHYSICS_BACKEND_META,
  PID_RATE_PRESETS,
  PhysicsBackendId,
  PhysicsEngineConfig,
  QuadPhysicsConfig,
  RapierBackendStatus,
  SavedPhysicsProfile,
  SimConfig,
  StickFunction,
  SubstepHz,
  SwitchFunction,
} from '../sim/types';
import { computeActualRateDeg, computeThrottleCurve } from '../sim/physics';
import { CONTROLLER_PRESETS, RawGamepadSnapshot } from '../sim/gamepad';
import { PWAInstallButton } from './PWAInstallButton';

type DrawerTab = 'controller' | 'pid' | 'physics' | 'camera';

const PROFILES_STORAGE_KEY = 'vektor_fpv_physics_profiles_v1';

function loadSavedProfiles(): SavedPhysicsProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

interface TuningDrawerProps {
  open: boolean;
  onClose: () => void;
  config: SimConfig;
  onChangeConfig: (updater: (prev: SimConfig) => SimConfig) => void;
  gamepadSnapshot: RawGamepadSnapshot;
  rapierStatus: RapierBackendStatus;
  onRechargeBattery: () => void;
  onResetDefaults: () => void;
}

const STICK_LABELS: Record<StickFunction, string> = {
  throttle: 'Throttle (Gas)',
  roll: 'Roll (Querruder)',
  pitch: 'Pitch (Nick)',
  yaw: 'Yaw (Gier)',
};

const SWITCH_LABELS: Record<SwitchFunction, string> = {
  arm: 'Arm / Disarm',
  mode: 'Flugmodus (Acro/Angle)',
  reset: 'Sofort-Reset',
};

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  decimals?: number;
  onChange: (val: number) => void;
}

const SliderRow: React.FC<SliderRowProps> = ({
  label,
  value,
  min,
  max,
  step,
  unit = '',
  decimals = 2,
  onChange,
}) => (
  <div className="flex flex-col gap-1.5">
    <div className="flex items-center justify-between text-xs">
      <span className="text-zinc-300">{label}</span>
      <span className="font-mono-tech font-medium text-amber-400">
        {value.toFixed(decimals)}
        {unit ? ` ${unit}` : ''}
      </span>
    </div>
    <input
      type="range"
      className="fpv-slider"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
    />
  </div>
);

export const TuningDrawer: React.FC<TuningDrawerProps> = ({
  open,
  onClose,
  config,
  onChangeConfig,
  gamepadSnapshot,
  rapierStatus,
  onRechargeBattery,
  onResetDefaults,
}) => {
  const [tab, setTab] = useState<DrawerTab>('pid');
  const [linkRollPitch, setLinkRollPitch] = useState(true);
  const [calibrating, setCalibrating] = useState(false);
  const [savedProfiles, setSavedProfiles] = useState<SavedPhysicsProfile[]>(loadSavedProfiles);
  const [profileName, setProfileName] = useState('');
  const [showImportJson, setShowImportJson] = useState(false);
  const [importJsonText, setImportJsonText] = useState('');
  const [profileFeedback, setProfileFeedback] = useState<string | null>(null);
  const calMinRef = useRef<number[]>([]);
  const calMaxRef = useRef<number[]>([]);

  useEffect(() => {
    try {
      localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(savedProfiles));
    } catch {
      // Ignore storage quota errors
    }
  }, [savedProfiles]);

  // Live endpoint capture during calibration wizard
  useEffect(() => {
    if (!calibrating || !gamepadSnapshot.connected) return;
    gamepadSnapshot.axes.forEach((v, idx) => {
      if (calMinRef.current[idx] === undefined || v < calMinRef.current[idx]) {
        calMinRef.current[idx] = v;
      }
      if (calMaxRef.current[idx] === undefined || v > calMaxRef.current[idx]) {
        calMaxRef.current[idx] = v;
      }
    });
  }, [calibrating, gamepadSnapshot]);

  const startCalibration = () => {
    calMinRef.current = [...gamepadSnapshot.axes];
    calMaxRef.current = [...gamepadSnapshot.axes];
    setCalibrating(true);
  };

  const finishCalibration = () => {
    setCalibrating(false);
    onChangeConfig((prev) => {
      const nextAxes = { ...prev.controller.axes };
      (['throttle', 'roll', 'pitch', 'yaw'] as StickFunction[]).forEach((fn) => {
        const ax = prev.controller.axes[fn];
        const idx = ax.axisIndex;
        const minV = calMinRef.current[idx] ?? -1;
        const maxV = calMaxRef.current[idx] ?? 1;
        const centerV = gamepadSnapshot.axes[idx] ?? 0;
        if (maxV - minV > 0.2) {
          nextAxes[fn] = {
            ...ax,
            min: Number(minV.toFixed(3)),
            max: Number(maxV.toFixed(3)),
            center: fn === 'throttle' ? Number(((minV + maxV) * 0.5).toFixed(3)) : Number(centerV.toFixed(3)),
          };
        }
      });
      return {
        ...prev,
        controller: { ...prev.controller, axes: nextAxes },
      };
    });
  };

  if (!open) return null;

  // Build Actual Rates Curve SVG polyline points
  const buildCurvePath = (axis: 'roll' | 'pitch' | 'yaw') => {
    const pts: string[] = [];
    const maxDeg = 1200;
    for (let i = 0; i <= 20; i++) {
      const s = i / 20;
      const deg = computeActualRateDeg(s, config.rates[axis]);
      const x = 16 + s * 268;
      const y = 94 - Math.min(1, deg / maxDeg) * 82;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return pts.join(' ');
  };

  const peakRoll = Math.round(computeActualRateDeg(1, config.rates.roll));
  const peakPitch = Math.round(computeActualRateDeg(1, config.rates.pitch));
  const peakYaw = Math.round(computeActualRateDeg(1, config.rates.yaw));

  const assignedAxisMap = new Map<number, string>();
  (['throttle', 'roll', 'pitch', 'yaw'] as StickFunction[]).forEach((fn) => {
    assignedAxisMap.set(config.controller.axes[fn].axisIndex, fn.toUpperCase());
  });
  (['arm', 'mode', 'reset'] as SwitchFunction[]).forEach((sw) => {
    const m = config.controller.switches[sw];
    if (m.sourceType === 'axis') {
      assignedAxisMap.set(m.index, sw.toUpperCase());
    }
  });

  const updateRateField = (
    axis: 'roll' | 'pitch' | 'yaw',
    field: 'centerSensitivity' | 'maxRate' | 'expo',
    val: number
  ) => {
    onChangeConfig((prev) => {
      const applyToAxis = (cur: typeof prev.rates.roll) => {
        const next = { ...cur, [field]: val };
        if (field === 'centerSensitivity' && next.maxRate < val) {
          next.maxRate = val;
        } else if (field === 'maxRate' && next.centerSensitivity > val) {
          next.centerSensitivity = val;
        }
        return next;
      };
      const nextRates = {
        ...prev.rates,
        [axis]: applyToAxis(prev.rates[axis]),
      };
      if (linkRollPitch && (axis === 'roll' || axis === 'pitch')) {
        nextRates.roll = applyToAxis(prev.rates.roll);
        nextRates.pitch = applyToAxis(prev.rates.pitch);
      }
      return { ...prev, rates: nextRates };
    });
  };

  const buildThrottleCurvePath = () => {
    const pts: string[] = [];
    for (let i = 0; i <= 20; i++) {
      const s = i / 20;
      const out = computeThrottleCurve(s, config.engine.throttleMid, config.engine.throttleExpo);
      const x = 14 + s * 272;
      const y = 76 - out * 64;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return pts.join(' ');
  };

  const applyFlightModel = (modelId: Exclude<FlightModelId, 'custom'>) => {
    const preset = FLIGHT_MODEL_PRESETS[modelId];
    onChangeConfig((prev) => ({
      ...prev,
      engine: {
        ...prev.engine,
        ...preset.engine,
        flightModel: modelId,
      },
      physics: {
        ...prev.physics,
        ...preset.physics,
      },
    }));
  };

  const updateEngineAeroField = <K extends keyof PhysicsEngineConfig>(
    field: K,
    val: PhysicsEngineConfig[K],
    markCustom = true
  ) => {
    onChangeConfig((prev) => ({
      ...prev,
      engine: {
        ...prev.engine,
        [field]: val,
        ...(markCustom ? { flightModel: 'custom' as FlightModelId } : {}),
      },
    }));
  };

  const updatePhysicsField = <K extends keyof QuadPhysicsConfig>(
    field: K,
    val: QuadPhysicsConfig[K],
    markCustom = true
  ) => {
    onChangeConfig((prev) => ({
      ...prev,
      engine: markCustom ? { ...prev.engine, flightModel: 'custom' } : prev.engine,
      physics: {
        ...prev.physics,
        [field]: val,
      },
    }));
  };

  const handleSaveProfile = () => {
    const trimmed = profileName.trim() || `Setup ${savedProfiles.length + 1}`;
    const nextProfile: SavedPhysicsProfile = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: trimmed,
      createdAt: Date.now(),
      engine: { ...config.engine },
      physics: { ...config.physics },
    };
    setSavedProfiles((prev) => [nextProfile, ...prev.slice(0, 11)]);
    setProfileName('');
    setProfileFeedback(`Profil „${trimmed}“ gespeichert`);
    window.setTimeout(() => setProfileFeedback(null), 2200);
  };

  const handleLoadProfile = (profile: SavedPhysicsProfile) => {
    onChangeConfig((prev) => ({
      ...prev,
      engine: { ...DEFAULT_SIM_CONFIG.engine, ...profile.engine },
      physics: { ...DEFAULT_SIM_CONFIG.physics, ...profile.physics },
    }));
    setProfileFeedback(`Profil „${profile.name}“ geladen`);
    window.setTimeout(() => setProfileFeedback(null), 2000);
  };

  const handleDeleteProfile = (id: string) => {
    setSavedProfiles((prev) => prev.filter((p) => p.id !== id));
  };

  const handleCopyPhysicsJson = async () => {
    const payload = JSON.stringify(
      { engine: config.engine, physics: config.physics },
      null,
      2
    );
    try {
      await navigator.clipboard.writeText(payload);
      setProfileFeedback('Physik-JSON in Zwischenablage kopiert');
    } catch {
      setImportJsonText(payload);
      setShowImportJson(true);
      setProfileFeedback('JSON unten markiert (Kopieren nicht erlaubt)');
    }
    window.setTimeout(() => setProfileFeedback(null), 2500);
  };

  const handleImportPhysicsJson = () => {
    try {
      const parsed = JSON.parse(importJsonText) as Partial<{
        engine: Partial<PhysicsEngineConfig>;
        physics: Partial<QuadPhysicsConfig>;
      }>;
      if (!parsed || (!parsed.engine && !parsed.physics)) {
        setProfileFeedback('Ungültiges JSON-Format (erwartet engine/physics)');
        return;
      }
      onChangeConfig((prev) => ({
        ...prev,
        engine: { ...prev.engine, ...parsed.engine },
        physics: { ...prev.physics, ...parsed.physics },
      }));
      setShowImportJson(false);
      setImportJsonText('');
      setProfileFeedback('Physik-Setup importiert');
      window.setTimeout(() => setProfileFeedback(null), 2200);
    } catch {
      setProfileFeedback('JSON konnte nicht gelesen werden');
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/50">
      <div className="flex h-full w-full max-w-[470px] flex-col border-l border-zinc-800 bg-zinc-950 text-zinc-100 shadow-2xl">
        {/* Drawer Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
          <div>
            <h2 className="font-display text-base font-bold tracking-wide text-white">
              Einstellungen
            </h2>
            <p className="text-xs text-zinc-400">
              Actual Rates, PID, Hybrid-Physik-Engines & Controller
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
            aria-label="Einstellungen schließen"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="grid grid-cols-4 gap-1 border-b border-zinc-800 bg-zinc-900/60 p-2">
          {(
            [
              { id: 'pid', label: 'Rates & PID', icon: Sliders },
              { id: 'controller', label: 'Controller', icon: Gamepad2 },
              { id: 'physics', label: 'Physik', icon: Wind },
              { id: 'camera', label: 'Kamera', icon: Camera },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`flex min-h-[40px] items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
                tab === id
                  ? 'bg-amber-500 text-zinc-950 font-semibold'
                  : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'
              }`}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span>{label}</span>
            </button>
          ))}
        </div>

        {/* Scrollable Tab Content */}
        <div className="drawer-scroll flex-1 overflow-y-auto px-5 py-5 space-y-6">
          {/* ================= TAB 1: CONTROLLER & KALIBRIERUNG ================= */}
          {tab === 'controller' && (
            <>
              {/* Connection Status Header */}
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-zinc-200">
                      {gamepadSnapshot.connected ? 'RC-Fernsteuerung erkannt' : 'Kein HID-Controller aktiv'}
                    </div>
                    <div className="mt-0.5 truncate font-mono-tech text-[11px] text-zinc-400">
                      {gamepadSnapshot.connected
                        ? gamepadSnapshot.id
                        : 'USB-C/Bluetooth-Sender verbinden & Stick bewegen'}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 font-mono-tech text-xs font-semibold ${
                      gamepadSnapshot.connected ? 'text-cyan-400' : 'text-amber-400'
                    }`}
                  >
                    {gamepadSnapshot.connected ? 'VERBUNDEN' : 'BEREIT'}
                  </span>
                </div>

                {/* Quick Presets */}
                <div className="mt-3 pt-3 border-t border-zinc-800">
                  <div className="mb-2 text-[11px] font-medium text-zinc-400">
                    Schnell-Profile (Kanalreihenfolge)
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {Object.entries(CONTROLLER_PRESETS).map(([key, preset]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() =>
                          onChangeConfig((prev) => ({
                            ...prev,
                            controller: {
                              ...prev.controller,
                              axes: JSON.parse(JSON.stringify(preset.axes)),
                              switches: JSON.parse(JSON.stringify(preset.switches)),
                            },
                          }))
                        }
                        className="min-h-[40px] rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-left text-xs font-medium text-zinc-200 transition-colors hover:border-amber-500/70 hover:text-white"
                      >
                        <div className="truncate">{preset.label}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Real-Time Axes 0-7 Visualizer */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-zinc-200">
                    Live-Achsenmonitor (Achsen 0–7)
                  </h3>
                  {!calibrating ? (
                    <button
                      type="button"
                      disabled={!gamepadSnapshot.connected}
                      onClick={startCalibration}
                      className="min-h-[36px] rounded-md bg-amber-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 transition-colors hover:bg-amber-400 disabled:opacity-40"
                    >
                      Endpunkte kalibrieren
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={finishCalibration}
                      className="flex min-h-[36px] items-center gap-1 rounded-md bg-cyan-400 px-3 py-1.5 text-xs font-semibold text-zinc-950"
                    >
                      <Check className="h-3.5 w-3.5" />
                      Mitte & Endpunkte speichern
                    </button>
                  )}
                </div>

                {calibrating && (
                  <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
                    Bewege jetzt beide Sticks langsam in alle 4 Ecken (Vollausschlag). Lass danach Roll, Pitch & Yaw in der Mitte los und klicke auf „Mitte & Endpunkte speichern“.
                  </p>
                )}

                <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                  {Array.from({ length: 8 }).map((_, idx) => {
                    const val = gamepadSnapshot.axes[idx] ?? 0;
                    const pct = Math.max(0, Math.min(100, (val + 1) * 50));
                    const mappedLabel = assignedAxisMap.get(idx);
                    return (
                      <div key={idx} className="grid grid-cols-[64px_1fr_54px] items-center gap-2.5">
                        <div className="font-mono-tech text-[11px] text-zinc-300">
                          AX {idx}
                          {mappedLabel && (
                            <span className="ml-1.5 text-[10px] font-semibold text-amber-400">
                              {mappedLabel}
                            </span>
                          )}
                        </div>
                        <div className="relative h-3.5 overflow-hidden rounded bg-zinc-950 border border-zinc-800">
                          {/* Center line */}
                          <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-600" />
                          {/* Value indicator bar from center or left */}
                          <div
                            className="absolute inset-y-0 bg-amber-500/85"
                            style={{
                              left: `${Math.min(50, pct)}%`,
                              width: `${Math.abs(pct - 50)}%`,
                            }}
                          />
                          <div
                            className="absolute top-0 bottom-0 w-1 bg-white"
                            style={{ left: `calc(${pct}% - 2px)` }}
                          />
                        </div>
                        <div className="font-mono-tech text-right text-[11px] text-zinc-400">
                          {val >= 0 ? '+' : ''}
                          {val.toFixed(2)}
                        </div>
                      </div>
                    );
                  })}

                  {/* Active Buttons Monitor */}
                  {gamepadSnapshot.buttons.length > 0 && (
                    <div className="mt-3 border-t border-zinc-800 pt-2.5">
                      <div className="mb-1.5 text-[11px] text-zinc-400">Tasten / Schalter (Buttons)</div>
                      <div className="flex flex-wrap gap-1.5">
                        {gamepadSnapshot.buttons.slice(0, 16).map((pressed, bIdx) => (
                          <span
                            key={bIdx}
                            className={`font-mono-tech rounded px-1.5 py-0.5 text-[10px] ${
                              pressed
                                ? 'bg-cyan-400 font-bold text-zinc-950'
                                : 'bg-zinc-950 text-zinc-500 border border-zinc-800'
                            }`}
                          >
                            B{bIdx}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Channel Mapping: Throttle, Roll, Pitch, Yaw */}
              <div className="space-y-3">
                <h3 className="text-xs font-semibold text-zinc-200">
                  Stick-Kanalzuordnung, Invertierung & Deadzone
                </h3>
                <div className="space-y-3">
                  {(['throttle', 'roll', 'pitch', 'yaw'] as StickFunction[]).map((fn) => {
                    const ax = config.controller.axes[fn];
                    return (
                      <div
                        key={fn}
                        className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-2.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium text-white">{STICK_LABELS[fn]}</span>
                          <div className="flex items-center gap-2">
                            <select
                              value={ax.axisIndex}
                              onChange={(e) => {
                                const axisIndex = Number(e.target.value);
                                onChangeConfig((prev) => ({
                                  ...prev,
                                  controller: {
                                    ...prev.controller,
                                    axes: {
                                      ...prev.controller.axes,
                                      [fn]: { ...prev.controller.axes[fn], axisIndex },
                                    },
                                  },
                                }));
                              }}
                              className="h-9 rounded-md border border-zinc-700 bg-zinc-950 px-2 font-mono-tech text-xs text-zinc-100"
                            >
                              {Array.from({ length: 8 }).map((_, i) => (
                                <option key={i} value={i}>
                                  Achse {i}
                                </option>
                              ))}
                            </select>

                            <button
                              type="button"
                              onClick={() =>
                                onChangeConfig((prev) => ({
                                  ...prev,
                                  controller: {
                                    ...prev.controller,
                                    axes: {
                                      ...prev.controller.axes,
                                      [fn]: {
                                        ...prev.controller.axes[fn],
                                        inverted: !prev.controller.axes[fn].inverted,
                                      },
                                    },
                                  },
                                }))
                              }
                              className={`h-9 rounded-md px-2.5 text-xs font-medium transition-colors ${
                                ax.inverted
                                  ? 'bg-amber-500 text-zinc-950'
                                  : 'border border-zinc-700 bg-zinc-950 text-zinc-300'
                              }`}
                            >
                              Invert
                            </button>
                          </div>
                        </div>

                        <SliderRow
                          label="Deadzone"
                          value={ax.deadzone * 100}
                          min={0}
                          max={20}
                          step={1}
                          unit="%"
                          decimals={0}
                          onChange={(val) =>
                            onChangeConfig((prev) => ({
                              ...prev,
                              controller: {
                                ...prev.controller,
                                axes: {
                                  ...prev.controller.axes,
                                  [fn]: { ...prev.controller.axes[fn], deadzone: val / 100 },
                                },
                              },
                            }))
                          }
                        />
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Auxiliary Switches: Arm, Flight Mode, Reset */}
              <div className="space-y-3">
                <h3 className="text-xs font-semibold text-zinc-200">
                  Schalter-Belegung (AUX-Kanäle / Buttons)
                </h3>
                <div className="space-y-2.5">
                  {(['arm', 'mode', 'reset'] as SwitchFunction[]).map((sw) => {
                    const m = config.controller.switches[sw];
                    return (
                      <div
                        key={sw}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3"
                      >
                        <span className="text-xs font-medium text-zinc-200">{SWITCH_LABELS[sw]}</span>
                        <div className="flex items-center gap-1.5">
                          <select
                            value={m.sourceType}
                            onChange={(e) => {
                              const sourceType = e.target.value as ControllerConfig['switches']['arm']['sourceType'];
                              onChangeConfig((prev) => ({
                                ...prev,
                                controller: {
                                  ...prev.controller,
                                  switches: {
                                    ...prev.controller.switches,
                                    [sw]: { ...prev.controller.switches[sw], sourceType },
                                  },
                                },
                              }));
                            }}
                            className="h-9 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-200"
                          >
                            <option value="axis">Achse (AUX)</option>
                            <option value="button">Taste (Btn)</option>
                            <option value="none">Aus</option>
                          </select>

                          {m.sourceType !== 'none' && (
                            <select
                              value={m.index}
                              onChange={(e) => {
                                const index = Number(e.target.value);
                                onChangeConfig((prev) => ({
                                  ...prev,
                                  controller: {
                                    ...prev.controller,
                                    switches: {
                                      ...prev.controller.switches,
                                      [sw]: { ...prev.controller.switches[sw], index },
                                    },
                                  },
                                }));
                              }}
                              className="h-9 rounded-md border border-zinc-700 bg-zinc-950 px-2 font-mono-tech text-xs text-zinc-200"
                            >
                              {Array.from({ length: m.sourceType === 'axis' ? 8 : 16 }).map((_, i) => (
                                <option key={i} value={i}>
                                  {m.sourceType === 'axis' ? `AX ${i}` : `B${i}`}
                                </option>
                              ))}
                            </select>
                          )}

                          {m.sourceType !== 'none' && (
                            <button
                              type="button"
                              onClick={() =>
                                onChangeConfig((prev) => ({
                                  ...prev,
                                  controller: {
                                    ...prev.controller,
                                    switches: {
                                      ...prev.controller.switches,
                                      [sw]: {
                                        ...prev.controller.switches[sw],
                                        inverted: !prev.controller.switches[sw].inverted,
                                      },
                                    },
                                  },
                                }))
                              }
                              className={`h-9 rounded-md px-2 text-xs ${
                                m.inverted
                                  ? 'bg-amber-500 text-zinc-950 font-semibold'
                                  : 'border border-zinc-700 bg-zinc-950 text-zinc-400'
                              }`}
                            >
                              Inv
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Compact iPad Air Setup Guide */}
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3.5 text-xs leading-relaxed text-zinc-400 space-y-1.5">
                <div className="font-semibold text-zinc-200">
                  iPad Air Anschluss (EdgeTX / OpenTX / TBS)
                </div>
                <p>
                  1. Fernsteuerung einschalten und per USB-C-Kabel (Daten-Port oben an der Funke) mit dem iPad Air verbinden.
                </p>
                <p>
                  2. Im Sender-Popup <span className="text-zinc-200">USB Joystick (HID)</span> wählen (alternativ ELRS BLE-Joystick unter iPadOS Bluetooth koppeln).
                </p>
                <p>
                  3. Einmal einen Stick bewegen, Preset wählen und oben auf <span className="text-amber-400">Endpunkte kalibrieren</span> tippen.
                </p>
              </div>
            </>
          )}

          {/* ================= TAB 2: PID & BETAFLIGHT RATES ================= */}
          {tab === 'pid' && (
            <>
              {/* Presets */}
              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-zinc-200">Flight-Controller-Profile</h3>
                <div className="grid grid-cols-1 gap-2">
                  {Object.entries(PID_RATE_PRESETS).map(([key, preset]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() =>
                        onChangeConfig((prev) => ({
                          ...prev,
                          pid: JSON.parse(JSON.stringify(preset.pid)),
                          rates: JSON.parse(JSON.stringify(preset.rates)),
                        }))
                      }
                      className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3.5 py-2.5 text-left transition-colors hover:border-amber-500/70"
                    >
                      <div className="text-xs font-semibold text-white">{preset.label}</div>
                      <div className="mt-0.5 text-[11px] text-zinc-400">{preset.description}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Live Actual Rates Curve Visualizer */}
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3.5">
                <div className="mb-2 flex items-center justify-between text-xs">
                  <span className="font-semibold text-zinc-200">Actual Rates-Kurve</span>
                  <span className="font-mono-tech text-[11px] text-zinc-400">
                    R {peakRoll}°/s · P {peakPitch}°/s · Y {peakYaw}°/s
                  </span>
                </div>
                <svg viewBox="0 0 300 105" className="h-28 w-full rounded border border-zinc-800 bg-zinc-950">
                  <line x1="16" y1="94" x2="284" y2="94" stroke="#27272a" strokeWidth="1" />
                  <line x1="16" y1="53" x2="284" y2="53" stroke="#27272a" strokeWidth="1" strokeDasharray="3 3" />
                  <line x1="16" y1="12" x2="284" y2="12" stroke="#27272a" strokeWidth="1" strokeDasharray="3 3" />
                  <line x1="150" y1="12" x2="150" y2="94" stroke="#27272a" strokeWidth="1" strokeDasharray="3 3" />
                  <polyline fill="none" stroke="#f59e0b" strokeWidth="2.2" points={buildCurvePath('roll')} />
                  <polyline fill="none" stroke="#38bdf8" strokeWidth="1.6" strokeDasharray="4 2" points={buildCurvePath('pitch')} />
                  <polyline fill="none" stroke="#a1a1aa" strokeWidth="1.4" points={buildCurvePath('yaw')} />
                </svg>
              </div>

              {/* Actual Rates per Axis */}
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-zinc-200">
                    Actual Rates (Center · Max Rate · Expo)
                  </h3>
                  <button
                    type="button"
                    onClick={() => setLinkRollPitch((v) => !v)}
                    className={`h-8 rounded-md px-2.5 text-[11px] font-medium transition-colors ${
                      linkRollPitch
                        ? 'border border-amber-500/40 bg-amber-500/20 text-amber-300'
                        : 'border border-zinc-700 bg-zinc-950 text-zinc-400'
                    }`}
                  >
                    {linkRollPitch ? 'Roll & Pitch gekoppelt' : 'Einzelachsen'}
                  </button>
                </div>

                {(['roll', 'pitch', 'yaw'] as const).map((axis) => {
                  const peak = Math.round(computeActualRateDeg(1, config.rates[axis]));
                  return (
                    <div key={axis} className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold uppercase tracking-wider text-amber-400">
                          {axis}
                        </span>
                        <span className="font-mono-tech text-xs text-zinc-300">
                          Center {Math.round(config.rates[axis].centerSensitivity)} · Max {peak} °/s
                        </span>
                      </div>
                      <SliderRow
                        label="Center Sensitivity"
                        value={config.rates[axis].centerSensitivity}
                        min={20}
                        max={400}
                        step={10}
                        unit="°/s"
                        decimals={0}
                        onChange={(val) => updateRateField(axis, 'centerSensitivity', val)}
                      />
                      <SliderRow
                        label="Max Rate"
                        value={config.rates[axis].maxRate}
                        min={200}
                        max={1200}
                        step={10}
                        unit="°/s"
                        decimals={0}
                        onChange={(val) => updateRateField(axis, 'maxRate', val)}
                      />
                      <SliderRow
                        label="Expo"
                        value={config.rates[axis].expo}
                        min={0}
                        max={1.0}
                        step={0.02}
                        decimals={2}
                        onChange={(val) => updateRateField(axis, 'expo', val)}
                      />
                    </div>
                  );
                })}
              </div>

              {/* PID Gains per Axis */}
              <div className="space-y-4">
                <h3 className="text-xs font-semibold text-zinc-200">PID-Regler & Feedforward (400 Hz)</h3>
                {(['roll', 'pitch', 'yaw'] as const).map((axis) => (
                  <div key={axis} className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3.5">
                    <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400">
                      PID · {axis}
                    </div>
                    <SliderRow
                      label="P (Proportional / Steifigkeit)"
                      value={config.pid[axis].p}
                      min={0.2}
                      max={1.2}
                      step={0.02}
                      onChange={(val) =>
                        onChangeConfig((prev) => ({
                          ...prev,
                          pid: { ...prev.pid, [axis]: { ...prev.pid[axis], p: val } },
                        }))
                      }
                    />
                    <SliderRow
                      label="I (Integral / Spurtreue)"
                      value={config.pid[axis].i}
                      min={0.0}
                      max={2.2}
                      step={0.05}
                      onChange={(val) =>
                        onChangeConfig((prev) => ({
                          ...prev,
                          pid: { ...prev.pid, [axis]: { ...prev.pid[axis], i: val } },
                        }))
                      }
                    />
                    <SliderRow
                      label="D (Dämpfung / Stopp-Präzision)"
                      value={config.pid[axis].d}
                      min={0.0}
                      max={0.02}
                      step={0.0005}
                      decimals={4}
                      onChange={(val) =>
                        onChangeConfig((prev) => ({
                          ...prev,
                          pid: { ...prev.pid, [axis]: { ...prev.pid[axis], d: val } },
                        }))
                      }
                    />
                    <SliderRow
                      label="FF (Feedforward / Stick-Direktheit)"
                      value={config.pid[axis].ff}
                      min={0.0}
                      max={0.03}
                      step={0.001}
                      decimals={3}
                      onChange={(val) =>
                        onChangeConfig((prev) => ({
                          ...prev,
                          pid: { ...prev.pid, [axis]: { ...prev.pid[axis], ff: val } },
                        }))
                      }
                    />
                  </div>
                ))}

                {/* Angle Mode & Airmode */}
                <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3.5">
                  <SliderRow
                    label="Angle-Mode Max. Neigung"
                    value={config.pid.angleMaxDeg}
                    min={20}
                    max={70}
                    step={1}
                    unit="°"
                    decimals={0}
                    onChange={(val) =>
                      onChangeConfig((prev) => ({ ...prev, pid: { ...prev.pid, angleMaxDeg: val } }))
                    }
                  />
                  <SliderRow
                    label="Angle-Mode Rückstellkraft"
                    value={config.pid.angleStrength}
                    min={2}
                    max={10}
                    step={0.2}
                    decimals={1}
                    onChange={(val) =>
                      onChangeConfig((prev) => ({ ...prev, pid: { ...prev.pid, angleStrength: val } }))
                    }
                  />
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-xs text-zinc-300">Betaflight Airmode (0%-Gas-Autorität)</span>
                    <button
                      type="button"
                      onClick={() =>
                        onChangeConfig((prev) => ({
                          ...prev,
                          pid: { ...prev.pid, airmode: !prev.pid.airmode },
                        }))
                      }
                      className={`h-9 rounded-md px-3 text-xs font-semibold ${
                        config.pid.airmode
                          ? 'bg-amber-500 text-zinc-950'
                          : 'border border-zinc-700 bg-zinc-950 text-zinc-400'
                      }`}
                    >
                      {config.pid.airmode ? 'Aktiv' : 'Aus'}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ================= TAB 3: HYBRID-PHYSIK-ENGINES & FEINTUNING ================= */}
          {tab === 'physics' && (
            <>
              {/* LAYER 1: FLIGHT MODEL / AERO ENGINE */}
              <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h3 className="text-xs font-semibold text-zinc-100">
                      1. Flugmodell (Aero-Engine)
                    </h3>
                    <p className="text-[11px] text-zinc-400">
                      Bestimmt Schubkurve, Hangtime, BEMT-Aerodynamik & Quad-Charakter
                    </p>
                  </div>
                  {config.engine.flightModel === 'custom' && (
                    <span className="shrink-0 rounded border border-cyan-400/50 bg-cyan-400/15 px-2 py-0.5 font-mono-tech text-[10px] font-semibold text-cyan-300">
                      CUSTOM
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-2">
                  {(
                    Object.values(FLIGHT_MODEL_PRESETS)
                  ).map((preset) => {
                    const active = config.engine.flightModel === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => applyFlightModel(preset.id)}
                        className={`rounded-lg border px-3.5 py-2.5 text-left transition-colors ${
                          active
                            ? 'border-amber-500 bg-amber-500/12'
                            : 'border-zinc-800 bg-zinc-950/70 hover:border-zinc-600'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-white">{preset.label}</span>
                          <span
                            className={`font-mono-tech text-[10px] font-semibold ${
                              active ? 'text-amber-400' : 'text-zinc-400'
                            }`}
                          >
                            {preset.tag}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] leading-snug text-zinc-400">
                          {preset.description}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* LAYER 2: RIGID-BODY & INTEGRATOR BACKEND */}
              <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                <div className="flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-amber-400" />
                  <div>
                    <h3 className="text-xs font-semibold text-zinc-100">
                      2. Rigid-Body- & Integrator-Backend
                    </h3>
                    <p className="text-[11px] text-zinc-400">
                      Frei kombinierbar mit jedem Flugmodell — Live-Wechsel im Flug
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-2">
                  {(['custom-euler', 'custom-rk4', 'rapier3d'] as PhysicsBackendId[]).map((bId) => {
                    const meta = PHYSICS_BACKEND_META[bId];
                    const active = config.engine.backend === bId;
                    const rapierNote =
                      bId === 'rapier3d' && active
                        ? rapierStatus === 'ready'
                          ? 'WASM BEREIT'
                          : rapierStatus === 'loading'
                          ? 'LÄDT WASM...'
                          : rapierStatus === 'error'
                          ? 'FALLBACK'
                          : meta.badge
                        : meta.badge;

                    return (
                      <button
                        key={bId}
                        type="button"
                        onClick={() => updateEngineAeroField('backend', bId, false)}
                        className={`rounded-lg border px-3.5 py-2.5 text-left transition-colors ${
                          active
                            ? 'border-cyan-400 bg-cyan-400/12'
                            : 'border-zinc-800 bg-zinc-950/70 hover:border-zinc-600'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-white">{meta.label}</span>
                          <span
                            className={`font-mono-tech text-[10px] font-semibold ${
                              active ? 'text-cyan-300' : 'text-zinc-400'
                            }`}
                          >
                            {rapierNote}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] leading-snug text-zinc-400">
                          {meta.description}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Physics Substep Frequency */}
                <div className="flex items-center justify-between gap-2 pt-1">
                  <div>
                    <div className="text-xs font-medium text-zinc-200">Physik-Taktfrequenz</div>
                    <div className="text-[11px] text-zinc-400">
                      400 Hz empfohlen fürs iPad · 800 Hz für maximale PID-Präzision
                    </div>
                  </div>
                  <div className="flex rounded-md border border-zinc-700 bg-zinc-950 p-0.5">
                    {([200, 400, 800] as SubstepHz[]).map((hz) => (
                      <button
                        key={hz}
                        type="button"
                        onClick={() => updateEngineAeroField('substepHz', hz, false)}
                        className={`h-8 rounded px-2.5 font-mono-tech text-xs font-semibold ${
                          config.engine.substepHz === hz
                            ? 'bg-amber-500 text-zinc-950'
                            : 'text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {hz}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* FINE-TUNING 1: FLUGGEFÜHL, HANGTIME & SCHUBKURVE */}
              <div className="space-y-3.5 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                <h3 className="text-xs font-semibold text-zinc-200">
                  Fluggefühl, Hangtime & Schubkurve
                </h3>
                <SliderRow
                  label="Schwerkraft-Skala (Hangtime / Float)"
                  value={config.engine.gravityScale}
                  min={0.70}
                  max={1.30}
                  step={0.02}
                  unit="× G"
                  decimals={2}
                  onChange={(val) => updateEngineAeroField('gravityScale', val)}
                />
                <SliderRow
                  label="Thrust-Linearität (Betaflight thrust_linear)"
                  value={config.engine.thrustLinearity * 100}
                  min={0}
                  max={60}
                  step={2}
                  unit="%"
                  decimals={0}
                  onChange={(val) => updateEngineAeroField('thrustLinearity', val / 100)}
                />
                <SliderRow
                  label="Throttle Mid (Schwebegas-Punkt)"
                  value={config.engine.throttleMid * 100}
                  min={15}
                  max={65}
                  step={1}
                  unit="%"
                  decimals={0}
                  onChange={(val) => updateEngineAeroField('throttleMid', val / 100)}
                />
                <SliderRow
                  label="Throttle Expo (Sanfte Gas-Mitte)"
                  value={config.engine.throttleExpo}
                  min={0}
                  max={0.60}
                  step={0.02}
                  decimals={2}
                  onChange={(val) => updateEngineAeroField('throttleExpo', val)}
                />

                {/* Mini Throttle Curve Visualizer */}
                <div className="pt-1">
                  <div className="mb-1 flex items-center justify-between text-[11px] text-zinc-400">
                    <span>Gaskurve (Input → Motor-Schub)</span>
                    <span className="font-mono-tech">
                      Mid {Math.round(config.engine.throttleMid * 100)}% · Expo{' '}
                      {config.engine.throttleExpo.toFixed(2)}
                    </span>
                  </div>
                  <svg
                    viewBox="0 0 300 84"
                    className="h-20 w-full rounded border border-zinc-800 bg-zinc-950"
                  >
                    <line x1="14" y1="76" x2="286" y2="12" stroke="#27272a" strokeWidth="1" strokeDasharray="3 3" />
                    <line
                      x1={14 + config.engine.throttleMid * 272}
                      y1="12"
                      x2={14 + config.engine.throttleMid * 272}
                      y2="76"
                      stroke="#3f3f46"
                      strokeWidth="1"
                      strokeDasharray="2 2"
                    />
                    <polyline
                      fill="none"
                      stroke="#38bdf8"
                      strokeWidth="2.2"
                      points={buildThrottleCurvePath()}
                    />
                  </svg>
                </div>
              </div>

              {/* FINE-TUNING 2: ERWEITERTE AERODYNAMIK (BEMT & DRAG) */}
              <div className="space-y-3.5 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                <h3 className="text-xs font-semibold text-zinc-200">
                  Aerodynamik, BEMT & Turbulenzen
                </h3>
                <SliderRow
                  label="Advance-Ratio & Translational Lift (BEMT)"
                  value={config.engine.advanceRatioLoss * 100}
                  min={0}
                  max={200}
                  step={5}
                  unit="%"
                  decimals={0}
                  onChange={(val) => updateEngineAeroField('advanceRatioLoss', val / 100)}
                />
                <SliderRow
                  label="Blade-Flapping & Rotor-H-Force"
                  value={config.engine.bladeFlapping * 100}
                  min={0}
                  max={200}
                  step={5}
                  unit="%"
                  decimals={0}
                  onChange={(val) => updateEngineAeroField('bladeFlapping', val / 100)}
                />
                <SliderRow
                  label="Propeller-Rotationsdämpfung"
                  value={config.engine.rotationalDrag * 100}
                  min={20}
                  max={250}
                  step={5}
                  unit="%"
                  decimals={0}
                  onChange={(val) => updateEngineAeroField('rotationalDrag', val / 100)}
                />
                <SliderRow
                  label="Prop-Wash-Turbulenz (Sinkflug)"
                  value={config.physics.propWashFactor * 100}
                  min={0}
                  max={180}
                  step={5}
                  unit="%"
                  decimals={0}
                  onChange={(val) => updatePhysicsField('propWashFactor', val / 100)}
                />
                <SliderRow
                  label="Bodeneffekt (Ground Effect)"
                  value={config.physics.groundEffectStrength * 100}
                  min={0}
                  max={150}
                  step={5}
                  unit="%"
                  decimals={0}
                  onChange={(val) => updatePhysicsField('groundEffectStrength', val / 100)}
                />
                <SliderRow
                  label="Luftwiderstand Stirnfläche (Cd·A)"
                  value={config.physics.dragFrontArea}
                  min={0.01}
                  max={0.09}
                  step={0.002}
                  unit="m²"
                  decimals={3}
                  onChange={(val) => updatePhysicsField('dragFrontArea', val)}
                />
                <SliderRow
                  label="Luftwiderstand Flachplatte Top/Bottom"
                  value={config.physics.dragTopArea}
                  min={0.05}
                  max={0.22}
                  step={0.005}
                  unit="m²"
                  decimals={3}
                  onChange={(val) => updatePhysicsField('dragTopArea', val)}
                />
                <SliderRow
                  label="Luftdichte (Höhenlage)"
                  value={config.physics.airDensity}
                  min={0.95}
                  max={1.35}
                  step={0.025}
                  unit="kg/m³"
                  decimals={3}
                  onChange={(val) => updatePhysicsField('airDensity', val)}
                />
              </div>

              {/* FINE-TUNING 3: KOLLISIONS- & ABPRALLPHYSIK */}
              <div className="space-y-3.5 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                <h3 className="text-xs font-semibold text-zinc-200">
                  Kollisions- & Abprallphysik
                </h3>
                <SliderRow
                  label="Abprall-Elastizität (Restitution)"
                  value={config.engine.collisionRestitution * 100}
                  min={5}
                  max={85}
                  step={5}
                  unit="%"
                  decimals={0}
                  onChange={(val) => updateEngineAeroField('collisionRestitution', val / 100, false)}
                />
                <SliderRow
                  label="Oberflächen-Reibung (Friction)"
                  value={config.engine.collisionFriction}
                  min={0.1}
                  max={1.5}
                  step={0.05}
                  decimals={2}
                  onChange={(val) => updateEngineAeroField('collisionFriction', val, false)}
                />
                <SliderRow
                  label="Kollisions-Spin bei Streifern"
                  value={config.engine.collisionSpinFactor * 100}
                  min={0}
                  max={150}
                  step={5}
                  unit="%"
                  decimals={0}
                  onChange={(val) => updateEngineAeroField('collisionSpinFactor', val / 100, false)}
                />
              </div>

              {/* FINE-TUNING 4: RIGID BODY, TRÄGHEIT & ANTRIEB */}
              <div className="space-y-3.5 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                <h3 className="text-xs font-semibold text-zinc-200">
                  Rigid Body, Trägheitstensor & Antrieb
                </h3>
                <SliderRow
                  label="Abfluggewicht (Masse)"
                  value={config.physics.massKg * 1000}
                  min={250}
                  max={1100}
                  step={10}
                  unit="g"
                  decimals={0}
                  onChange={(val) => updatePhysicsField('massKg', val / 1000)}
                />
                <SliderRow
                  label="Schub-Gewichts-Verhältnis (TWR)"
                  value={config.physics.maxThrustToWeight}
                  min={3.5}
                  max={13.0}
                  step={0.2}
                  unit=":1"
                  decimals={1}
                  onChange={(val) => updatePhysicsField('maxThrustToWeight', val)}
                />
                <SliderRow
                  label="Armlänge (Motor-Hebelarm)"
                  value={config.physics.armLengthM * 1000}
                  min={65}
                  max={160}
                  step={2}
                  unit="mm"
                  decimals={0}
                  onChange={(val) => updatePhysicsField('armLengthM', val / 1000)}
                />
                <SliderRow
                  label="Trägheit Pitch (Ix)"
                  value={config.physics.inertiaX * 1000}
                  min={1.4}
                  max={8.0}
                  step={0.1}
                  unit="g·m²"
                  decimals={1}
                  onChange={(val) => updatePhysicsField('inertiaX', val / 1000)}
                />
                <SliderRow
                  label="Trägheit Roll (Iz)"
                  value={config.physics.inertiaZ * 1000}
                  min={1.2}
                  max={7.5}
                  step={0.1}
                  unit="g·m²"
                  decimals={1}
                  onChange={(val) => updatePhysicsField('inertiaZ', val / 1000)}
                />
                <SliderRow
                  label="Trägheit Yaw (Iy)"
                  value={config.physics.inertiaY * 1000}
                  min={2.2}
                  max={12.0}
                  step={0.2}
                  unit="g·m²"
                  decimals={1}
                  onChange={(val) => updatePhysicsField('inertiaY', val / 1000)}
                />
                <SliderRow
                  label="Motor Spool-Up Verzögerung"
                  value={config.physics.motorSpoolUpMs}
                  min={6}
                  max={70}
                  step={2}
                  unit="ms"
                  decimals={0}
                  onChange={(val) => updatePhysicsField('motorSpoolUpMs', val)}
                />
                <SliderRow
                  label="Motor Spool-Down (Active Braking)"
                  value={config.physics.motorSpoolDownMs}
                  min={8}
                  max={90}
                  step={2}
                  unit="ms"
                  decimals={0}
                  onChange={(val) => updatePhysicsField('motorSpoolDownMs', val)}
                />
                <SliderRow
                  label="Yaw-Drehmoment (Gegenlauf)"
                  value={config.physics.yawTorqueCoeff}
                  min={0.02}
                  max={0.10}
                  step={0.002}
                  decimals={3}
                  onChange={(val) => updatePhysicsField('yawTorqueCoeff', val)}
                />
              </div>

              {/* WIND & BÖEN */}
              <div className="space-y-3.5 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                <h3 className="text-xs font-semibold text-zinc-200">Wind & Böen</h3>
                <SliderRow
                  label="Windgeschwindigkeit"
                  value={config.wind.speedMs}
                  min={0}
                  max={14}
                  step={0.2}
                  unit="m/s"
                  decimals={1}
                  onChange={(val) =>
                    onChangeConfig((prev) => ({ ...prev, wind: { ...prev.wind, speedMs: val } }))
                  }
                />
                <SliderRow
                  label="Windrichtung (aus)"
                  value={config.wind.directionDeg}
                  min={0}
                  max={355}
                  step={5}
                  unit="°"
                  decimals={0}
                  onChange={(val) =>
                    onChangeConfig((prev) => ({ ...prev, wind: { ...prev.wind, directionDeg: val } }))
                  }
                />
                <SliderRow
                  label="Böen-Intensität"
                  value={config.wind.gustIntensity * 100}
                  min={0}
                  max={100}
                  step={5}
                  unit="%"
                  decimals={0}
                  onChange={(val) =>
                    onChangeConfig((prev) => ({
                      ...prev,
                      wind: { ...prev.wind, gustIntensity: val / 100 },
                    }))
                  }
                />
              </div>

              {/* 6S LIPO SIMULATION */}
              <div className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                <div>
                  <div className="text-xs font-semibold text-zinc-200">6S LiPo Simulation</div>
                  <div className="text-[11px] text-zinc-400">
                    Entladung & Voltage-Sag bei Vollgas
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onRechargeBattery}
                    className="flex h-9 items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-950 px-2.5 text-xs font-medium text-cyan-300 hover:bg-zinc-800"
                  >
                    <BatteryCharging className="h-3.5 w-3.5" />
                    Neu laden
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      updatePhysicsField('simulateBattery', !config.physics.simulateBattery, false)
                    }
                    className={`h-9 rounded-md px-3 text-xs font-semibold ${
                      config.physics.simulateBattery
                        ? 'bg-amber-500 text-zinc-950'
                        : 'border border-zinc-700 bg-zinc-950 text-zinc-400'
                    }`}
                  >
                    {config.physics.simulateBattery ? 'Ein' : 'Aus'}
                  </button>
                </div>
              </div>

              {/* CUSTOM SAVED PHYSICS PROFILES & JSON IMPORT/EXPORT */}
              <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-zinc-200">
                    Eigene Physik-Profile & Export
                  </h3>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={handleCopyPhysicsJson}
                      className="flex h-8 items-center gap-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-[11px] font-medium text-zinc-300 hover:border-amber-500/60 hover:text-white"
                      title="Aktuelles Physik-Setup als JSON kopieren"
                    >
                      <Copy className="h-3 w-3" />
                      JSON
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowImportJson((v) => !v)}
                      className="flex h-8 items-center gap-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-[11px] font-medium text-zinc-300 hover:border-cyan-400/60 hover:text-white"
                    >
                      <Upload className="h-3 w-3" />
                      Import
                    </button>
                  </div>
                </div>

                {/* Save Current Setup Row */}
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                    placeholder="Profilname (z. B. Mein 5-Zoll BEMT)"
                    maxLength={32}
                    className="h-9 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleSaveProfile}
                    className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-amber-500 px-3 text-xs font-semibold text-zinc-950 hover:bg-amber-400"
                  >
                    <Save className="h-3.5 w-3.5" />
                    Speichern
                  </button>
                </div>

                {profileFeedback && (
                  <div className="rounded border border-cyan-400/40 bg-cyan-400/10 px-2.5 py-1.5 text-[11px] text-cyan-200">
                    {profileFeedback}
                  </div>
                )}

                {showImportJson && (
                  <div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-950 p-2.5">
                    <textarea
                      value={importJsonText}
                      onChange={(e) => setImportJsonText(e.target.value)}
                      rows={4}
                      placeholder='{"engine": {...}, "physics": {...}}'
                      className="w-full rounded border border-zinc-800 bg-zinc-900 p-2 font-mono-tech text-[11px] text-zinc-200 focus:border-cyan-400 focus:outline-none"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setShowImportJson(false)}
                        className="h-8 rounded px-2.5 text-xs text-zinc-400 hover:text-zinc-200"
                      >
                        Abbrechen
                      </button>
                      <button
                        type="button"
                        onClick={handleImportPhysicsJson}
                        className="h-8 rounded bg-cyan-400 px-3 text-xs font-semibold text-zinc-950 hover:bg-cyan-300"
                      >
                        Setup laden
                      </button>
                    </div>
                  </div>
                )}

                {savedProfiles.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    {savedProfiles.map((prof) => (
                      <div
                        key={prof.id}
                        className="flex items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-950/80 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-zinc-100">
                            {prof.name}
                          </div>
                          <div className="font-mono-tech text-[10px] text-zinc-400">
                            {prof.engine.flightModel.toUpperCase()} ·{' '}
                            {PHYSICS_BACKEND_META[prof.engine.backend]?.shortLabel ?? prof.engine.backend} ·{' '}
                            {prof.engine.substepHz} Hz · {Math.round(prof.physics.massKg * 1000)}g
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleLoadProfile(prof)}
                            className="h-8 rounded border border-zinc-700 bg-zinc-900 px-2.5 text-xs font-medium text-amber-400 hover:border-amber-500/70"
                          >
                            Laden
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteProfile(prof.id)}
                            className="flex h-8 w-8 items-center justify-center rounded border border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-red-500/60 hover:text-red-400"
                            aria-label={`Profil ${prof.name} löschen`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ================= TAB 4: KAMERA & GRAFIK ================= */}
          {tab === 'camera' && (
            <>
              <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                <h3 className="text-xs font-semibold text-zinc-200">FPV-Kamera & Optik</h3>
                <SliderRow
                  label="Kamera-Neigungswinkel (Tilt)"
                  value={config.camera.tiltDeg}
                  min={0}
                  max={55}
                  step={1}
                  unit="°"
                  decimals={0}
                  onChange={(val) =>
                    onChangeConfig((prev) => ({
                      ...prev,
                      camera: { ...prev.camera, tiltDeg: val },
                    }))
                  }
                />
                <SliderRow
                  label="Sichtfeld (FOV)"
                  value={config.camera.fovDeg}
                  min={85}
                  max={135}
                  step={1}
                  unit="°"
                  decimals={0}
                  onChange={(val) =>
                    onChangeConfig((prev) => ({
                      ...prev,
                      camera: { ...prev.camera, fovDeg: val },
                    }))
                  }
                />
                <SliderRow
                  label="FPV-Linse (Fischaugen-Verzerrung)"
                  value={config.camera.fisheyeStrength * 100}
                  min={0}
                  max={45}
                  step={1}
                  unit="%"
                  decimals={0}
                  onChange={(val) =>
                    onChangeConfig((prev) => ({
                      ...prev,
                      camera: { ...prev.camera, fisheyeStrength: val / 100 },
                    }))
                  }
                />

                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-zinc-300">Kameraperspektive</span>
                  <div className="flex rounded-md border border-zinc-700 bg-zinc-950 p-0.5">
                    {(['FPV', 'CHASE'] as CameraViewMode[]).map((vm) => (
                      <button
                        key={vm}
                        type="button"
                        onClick={() =>
                          onChangeConfig((prev) => ({
                            ...prev,
                            camera: { ...prev.camera, viewMode: vm },
                          }))
                        }
                        className={`h-8 rounded px-3 text-xs font-semibold ${
                          config.camera.viewMode === vm
                            ? 'bg-amber-500 text-zinc-950'
                            : 'text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {vm === 'FPV' ? 'FPV-Linse' : 'Verfolger'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="space-y-3.5 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                <h3 className="text-xs font-semibold text-zinc-200">iPad Air Performance & Touch</h3>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs text-zinc-200">Adaptive Pixel-Ratio</div>
                    <div className="text-[11px] text-zinc-400">
                      Hält 60–120 FPS stabil auf Apple Silicon
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      onChangeConfig((prev) => ({
                        ...prev,
                        camera: {
                          ...prev.camera,
                          adaptivePixelRatio: !prev.camera.adaptivePixelRatio,
                        },
                      }))
                    }
                    className={`h-9 rounded-md px-3 text-xs font-semibold ${
                      config.camera.adaptivePixelRatio
                        ? 'bg-amber-500 text-zinc-950'
                        : 'border border-zinc-700 bg-zinc-950 text-zinc-400'
                    }`}
                  >
                    {config.camera.adaptivePixelRatio ? 'Auto' : 'Nativ'}
                  </button>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs text-zinc-200">Propellerspitzen im FPV-Bild</div>
                    <div className="text-[11px] text-zinc-400">
                      Sichtbar bei geringem Kamera-Tilt
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      onChangeConfig((prev) => ({
                        ...prev,
                        camera: {
                          ...prev.camera,
                          showPropsInFpv: !prev.camera.showPropsInFpv,
                        },
                      }))
                    }
                    className={`h-9 rounded-md px-3 text-xs font-semibold ${
                      config.camera.showPropsInFpv
                        ? 'bg-amber-500 text-zinc-950'
                        : 'border border-zinc-700 bg-zinc-950 text-zinc-400'
                    }`}
                  >
                    {config.camera.showPropsInFpv ? 'Ein' : 'Aus'}
                  </button>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs text-zinc-200">On-Screen Touch-Sticks (Mode 2)</div>
                    <div className="text-[11px] text-zinc-400">
                      Auto blendet aus sobald RC verbunden ist
                    </div>
                  </div>
                  <div className="flex rounded-md border border-zinc-700 bg-zinc-950 p-0.5">
                    {(
                      [
                        { id: 'auto', label: 'Auto' },
                        { id: 'always', label: 'Immer' },
                        { id: 'hidden', label: 'Aus' },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() =>
                          onChangeConfig((prev) => ({
                            ...prev,
                            controller: { ...prev.controller, showTouchSticks: opt.id },
                          }))
                        }
                        className={`h-8 rounded px-2.5 text-xs font-medium ${
                          config.controller.showTouchSticks === opt.id
                            ? 'bg-amber-500 text-zinc-950 font-semibold'
                            : 'text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <PWAInstallButton variant="card" />
            </>
          )}
        </div>

        {/* Drawer Footer */}
        <div className="flex items-center justify-between border-t border-zinc-800 px-5 py-3">
          <button
            type="button"
            onClick={() => {
              onResetDefaults();
              setCalibrating(false);
            }}
            className="flex min-h-[40px] items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-100"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Werkseinstellungen
          </button>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-zinc-950 transition-colors hover:bg-amber-400"
          >
            Weiterfliegen
          </button>
        </div>
      </div>
    </div>
  );
};

export { DEFAULT_SIM_CONFIG };
