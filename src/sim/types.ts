export type FlightMode = 'ACRO' | 'ANGLE';
export type CameraViewMode = 'FPV' | 'CHASE';

export type FlightModelId =
  | 'classic-6dof'
  | 'pro-bemt'
  | 'racing-crisp'
  | 'freestyle-juicy'
  | 'cinewhoop'
  | 'custom';

export type PhysicsBackendId = 'custom-euler' | 'custom-rk4' | 'rapier3d';
export type SubstepHz = 200 | 400 | 800;
export type RapierBackendStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PhysicsEngineConfig {
  flightModel: FlightModelId;
  backend: PhysicsBackendId;
  substepHz: SubstepHz;
  gravityScale: number; // 0.70..1.30 (1.0 = 9.81 m/s^2, <1 = more hangtime/float)
  thrustLinearity: number; // 0.0..0.60 (0 = pure RPM^2, higher = Betaflight thrust_linear)
  throttleMid: number; // 0.15..0.65 (center of throttle expo flattening)
  throttleExpo: number; // 0.0..0.60 (0 = linear throttle, >0 = smoother hover control)
  advanceRatioLoss: number; // 0.0..2.0 (BEMT axial inflow thrust loss + translational lift)
  bladeFlapping: number; // 0.0..2.0 (high-speed rotor flapping pitch-back & H-force drag)
  rotationalDrag: number; // 0.2..2.5 (aerodynamic propeller rotational damping multiplier)
  collisionRestitution: number; // 0.05..0.85 (bounce elasticity)
  collisionFriction: number; // 0.1..1.5 (surface skid & glancing friction)
  collisionSpinFactor: number; // 0.0..1.5 (spin transfer on obstacle impacts)
}

export interface SavedPhysicsProfile {
  id: string;
  name: string;
  createdAt: number;
  engine: PhysicsEngineConfig;
  physics: QuadPhysicsConfig;
}

export interface PidAxisGains {
  p: number;
  i: number;
  d: number;
  ff: number; // Betaflight Feedforward (instant stick-rate response)
}

export interface PidConfig {
  roll: PidAxisGains;
  pitch: PidAxisGains;
  yaw: PidAxisGains;
  angleStrength: number; // Outer loop P-gain in Angle mode
  angleMaxDeg: number; // Max tilt angle in Angle mode (deg)
  airmode: boolean; // Keep full PID authority at 0% throttle
}

export interface RateAxisConfig {
  centerSensitivity: number; // Actual Rates Center Sensitivity (deg/s, 20 - 400)
  maxRate: number; // Actual Rates Max Angular Velocity (deg/s, 200 - 1200)
  expo: number; // Actual Rates Expo (0.0 - 1.0)
}

export interface RatesConfig {
  roll: RateAxisConfig;
  pitch: RateAxisConfig;
  yaw: RateAxisConfig;
}

export interface WindConfig {
  speedMs: number; // Mean wind speed in m/s
  directionDeg: number; // Wind coming FROM direction in degrees (0 = North/-Z)
  gustIntensity: number; // 0..1 turbulence & gust factor
}

export interface QuadPhysicsConfig {
  massKg: number; // Default 0.65 kg (5" freestyle quad + 6S LiPo + action cam)
  armLengthM: number; // Default 0.115 m
  inertiaX: number; // Pitch inertia kg*m^2
  inertiaY: number; // Yaw inertia kg*m^2
  inertiaZ: number; // Roll inertia kg*m^2
  maxThrustToWeight: number; // e.g., 9.2:1 for a snappy 6S 5" quad
  airDensity: number; // 1.225 kg/m^3 at sea level
  motorSpoolUpMs: number; // Motor spin-up time constant (ms)
  motorSpoolDownMs: number; // Motor active-braking spin-down time constant (ms)
  propWashFactor: number; // 0..2 strength of prop-wash turbulence during descent
  dragFrontArea: number; // Equivalent Cd*A frontal/side (m^2)
  dragTopArea: number; // Equivalent Cd*A top/bottom flat plate (m^2)
  groundEffectStrength: number; // 0..1.5 aerodynamic ground cushion near ground
  yawTorqueCoeff: number; // Counter-rotating reaction torque strength
  simulateBattery: boolean; // Voltage sag & capacity drain
  batteryCells: number; // 6S default
  batteryCapacityMah: number; // 1300 mAh
}

export interface CameraConfig {
  tiltDeg: number; // 0 to 55 degrees
  fovDeg: number; // 85 to 135 degrees
  fisheyeStrength: number; // 0 to 0.45 barrel distortion
  viewMode: CameraViewMode;
  adaptivePixelRatio: boolean;
  showPropsInFpv: boolean;
}

export type StickFunction = 'throttle' | 'roll' | 'pitch' | 'yaw';
export type SwitchFunction = 'arm' | 'mode' | 'reset';

export interface AxisCalibration {
  axisIndex: number; // Gamepad axes[] index (0..7)
  inverted: boolean;
  deadzone: number; // 0.0 to 0.25
  min: number; // Calibrated min raw value (default -1)
  center: number; // Calibrated center raw value (default 0)
  max: number; // Calibrated max raw value (default 1)
}

export interface SwitchMapping {
  sourceType: 'axis' | 'button' | 'none';
  index: number;
  threshold: number; // For axis: value > threshold activates
  inverted: boolean;
}

export interface ControllerConfig {
  axes: Record<StickFunction, AxisCalibration>;
  switches: Record<SwitchFunction, SwitchMapping>;
  showTouchSticks: 'auto' | 'always' | 'hidden';
}

export interface SimConfig {
  engine: PhysicsEngineConfig;
  physics: QuadPhysicsConfig;
  pid: PidConfig;
  rates: RatesConfig;
  wind: WindConfig;
  camera: CameraConfig;
  controller: ControllerConfig;
  audioEnabled: boolean;
}

export interface ControlInputs {
  throttle: number; // 0..1
  roll: number; // -1..1 (right positive)
  pitch: number; // -1..1 (nose down / forward positive)
  yaw: number; // -1..1 (yaw right positive)
}

export interface TelemetrySnapshot {
  armed: boolean;
  crashed: boolean;
  crashReason: string;
  flightMode: FlightMode;
  throttlePct: number;
  speedKmh: number;
  verticalSpeedMs: number;
  altitudeM: number;
  voltageTotal: number;
  voltagePerCell: number;
  voltageSagV: number;
  currentA: number;
  mahUsed: number;
  batteryPct: number;
  flightTimeSec: number;
  pitchDeg: number; // Positive = nose up
  rollDeg: number; // Positive = right bank
  headingDeg: number; // 0..359
  motorRpm: [number, number, number, number];
  propWashIntensity: number; // 0..1
  groundEffectFactor: number; // 1.0+
  windSpeedMs: number;
  windDirDeg: number;
  fps: number;
  pixelRatio: number;
  activeGateIndex: number;
  totalGates: number;
  lapCount: number;
  currentLapSec: number;
  bestLapSec: number | null;
  gamepadConnected: boolean;
  gamepadName: string;
  controlSource: 'gamepad' | 'touch' | 'keyboard';
  activeFlightModel: FlightModelId;
  activeBackend: PhysicsBackendId;
  activeSubstepHz: SubstepHz;
  rapierStatus: RapierBackendStatus;
}

export interface CourseGate {
  id: number;
  x: number;
  y: number;
  z: number;
  yawRad: number; // Facing direction
  width: number;
  height: number;
}

export interface ColliderBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  label: string;
}

export interface ColliderCylinder {
  x: number;
  z: number;
  radius: number;
  minY: number;
  maxY: number;
  label: string;
}

export const DEFAULT_ENGINE_CONFIG: PhysicsEngineConfig = {
  flightModel: 'classic-6dof',
  backend: 'custom-euler',
  substepHz: 400,
  gravityScale: 1.0,
  thrustLinearity: 0.22,
  throttleMid: 0.30,
  throttleExpo: 0.0,
  advanceRatioLoss: 1.0,
  bladeFlapping: 0.35,
  rotationalDrag: 1.0,
  collisionRestitution: 0.32,
  collisionFriction: 0.65,
  collisionSpinFactor: 0.65,
};

export const DEFAULT_PHYSICS_CONFIG: QuadPhysicsConfig = {
  massKg: 0.65,
  armLengthM: 0.115,
  inertiaX: 0.0036,
  inertiaY: 0.0062,
  inertiaZ: 0.0032,
  maxThrustToWeight: 9.2,
  airDensity: 1.225,
  motorSpoolUpMs: 12,
  motorSpoolDownMs: 18,
  propWashFactor: 0.45,
  dragFrontArea: 0.052,
  dragTopArea: 0.125,
  groundEffectStrength: 0.85,
  yawTorqueCoeff: 0.055,
  simulateBattery: true,
  batteryCells: 6,
  batteryCapacityMah: 1300,
};

export const DEFAULT_PID_CONFIG: PidConfig = {
  roll: { p: 0.58, i: 1.15, d: 0.0068, ff: 0.011 },
  pitch: { p: 0.62, i: 1.20, d: 0.0074, ff: 0.012 },
  yaw: { p: 0.72, i: 1.35, d: 0.0028, ff: 0.009 },
  angleStrength: 7.8,
  angleMaxDeg: 55,
  airmode: true,
};

export const DEFAULT_RATES_CONFIG: RatesConfig = {
  roll: { centerSensitivity: 160, maxRate: 670, expo: 0.54 },
  pitch: { centerSensitivity: 160, maxRate: 670, expo: 0.54 },
  yaw: { centerSensitivity: 140, maxRate: 600, expo: 0.45 },
};

export const DEFAULT_WIND_CONFIG: WindConfig = {
  speedMs: 1.4,
  directionDeg: 35,
  gustIntensity: 0.25,
};

export const DEFAULT_CAMERA_CONFIG: CameraConfig = {
  tiltDeg: 25,
  fovDeg: 112,
  fisheyeStrength: 0.18,
  viewMode: 'FPV',
  adaptivePixelRatio: true,
  showPropsInFpv: true,
};

export const DEFAULT_CONTROLLER_CONFIG: ControllerConfig = {
  // Default EdgeTX / OpenTX USB HID AETR mapping (Axis 0: Roll, 1: Pitch, 2: Throttle, 3: Yaw)
  axes: {
    roll: { axisIndex: 0, inverted: false, deadzone: 0.03, min: -1, center: 0, max: 1 },
    pitch: { axisIndex: 1, inverted: true, deadzone: 0.03, min: -1, center: 0, max: 1 },
    throttle: { axisIndex: 2, inverted: false, deadzone: 0.0, min: -1, center: 0, max: 1 },
    yaw: { axisIndex: 3, inverted: false, deadzone: 0.03, min: -1, center: 0, max: 1 },
  },
  switches: {
    arm: { sourceType: 'axis', index: 4, threshold: 0.1, inverted: false },
    mode: { sourceType: 'axis', index: 5, threshold: 0.1, inverted: false },
    reset: { sourceType: 'button', index: 0, threshold: 0.5, inverted: false },
  },
  showTouchSticks: 'auto',
};

export const DEFAULT_SIM_CONFIG: SimConfig = {
  engine: DEFAULT_ENGINE_CONFIG,
  physics: DEFAULT_PHYSICS_CONFIG,
  pid: DEFAULT_PID_CONFIG,
  rates: DEFAULT_RATES_CONFIG,
  wind: DEFAULT_WIND_CONFIG,
  camera: DEFAULT_CAMERA_CONFIG,
  controller: DEFAULT_CONTROLLER_CONFIG,
  audioEnabled: true,
};

export interface FlightModelPreset {
  id: Exclude<FlightModelId, 'custom'>;
  label: string;
  shortLabel: string;
  tag: string;
  description: string;
  engine: Omit<PhysicsEngineConfig, 'backend' | 'substepHz' | 'collisionRestitution' | 'collisionFriction' | 'collisionSpinFactor'>;
  physics: Partial<QuadPhysicsConfig>;
}

export const FLIGHT_MODEL_PRESETS: Record<Exclude<FlightModelId, 'custom'>, FlightModelPreset> = {
  'classic-6dof': {
    id: 'classic-6dof',
    label: 'Vektor 6-DOF',
    shortLabel: '6-DOF',
    tag: 'Allround',
    description: 'Ausgewogener 5-Zoll-Standard mit realistischem Schub, Bodeneffekt und moderatem Prop-Wash.',
    engine: {
      flightModel: 'classic-6dof',
      gravityScale: 1.0,
      thrustLinearity: 0.22,
      throttleMid: 0.30,
      throttleExpo: 0.0,
      advanceRatioLoss: 1.0,
      bladeFlapping: 0.35,
      rotationalDrag: 1.0,
    },
    physics: {
      massKg: 0.65,
      armLengthM: 0.115,
      inertiaX: 0.0036,
      inertiaY: 0.0062,
      inertiaZ: 0.0032,
      maxThrustToWeight: 9.2,
      motorSpoolUpMs: 12,
      motorSpoolDownMs: 18,
      propWashFactor: 0.45,
      dragFrontArea: 0.052,
      dragTopArea: 0.125,
      groundEffectStrength: 0.85,
      yawTorqueCoeff: 0.055,
    },
  },
  'pro-bemt': {
    id: 'pro-bemt',
    label: 'Pro-Aero (BEMT)',
    shortLabel: 'BEMT',
    tag: 'Realismus',
    description: 'Blattelement-Aerodynamik: spürbarer Advance-Ratio-Schubverlust, Translational Lift, Blade-Flapping & Prop-Wash.',
    engine: {
      flightModel: 'pro-bemt',
      gravityScale: 1.0,
      thrustLinearity: 0.14,
      throttleMid: 0.32,
      throttleExpo: 0.08,
      advanceRatioLoss: 1.55,
      bladeFlapping: 1.25,
      rotationalDrag: 1.15,
    },
    physics: {
      massKg: 0.68,
      armLengthM: 0.118,
      inertiaX: 0.0039,
      inertiaY: 0.0067,
      inertiaZ: 0.0035,
      maxThrustToWeight: 8.8,
      motorSpoolUpMs: 16,
      motorSpoolDownMs: 24,
      propWashFactor: 0.85,
      dragFrontArea: 0.056,
      dragTopArea: 0.145,
      groundEffectStrength: 1.05,
      yawTorqueCoeff: 0.062,
    },
  },
  'racing-crisp': {
    id: 'racing-crisp',
    label: 'Racing (Locked-In)',
    shortLabel: 'RACE',
    tag: 'Wettkampf',
    description: 'Ultrasteifes Gate-Racing-Feeling: Blitz-Spool, lineare Gasannahme, kaum Prop-Wash, knackige Drops.',
    engine: {
      flightModel: 'racing-crisp',
      gravityScale: 1.05,
      thrustLinearity: 0.36,
      throttleMid: 0.28,
      throttleExpo: 0.0,
      advanceRatioLoss: 0.55,
      bladeFlapping: 0.12,
      rotationalDrag: 1.35,
    },
    physics: {
      massKg: 0.54,
      armLengthM: 0.108,
      inertiaX: 0.0028,
      inertiaY: 0.0049,
      inertiaZ: 0.0025,
      maxThrustToWeight: 11.0,
      motorSpoolUpMs: 8,
      motorSpoolDownMs: 12,
      propWashFactor: 0.18,
      dragFrontArea: 0.042,
      dragTopArea: 0.105,
      groundEffectStrength: 0.55,
      yawTorqueCoeff: 0.064,
    },
  },
  'freestyle-juicy': {
    id: 'freestyle-juicy',
    label: 'Freestyle (Juicy)',
    shortLabel: 'FLOW',
    tag: 'Hangtime',
    description: 'Flüssiger Flow mit extra Hangtime, geschmeidiger Gas-Mitte (Throttle Expo) und sauberem Schwung bei Flips.',
    engine: {
      flightModel: 'freestyle-juicy',
      gravityScale: 0.90,
      thrustLinearity: 0.24,
      throttleMid: 0.34,
      throttleExpo: 0.24,
      advanceRatioLoss: 0.85,
      bladeFlapping: 0.45,
      rotationalDrag: 0.85,
    },
    physics: {
      massKg: 0.72,
      armLengthM: 0.118,
      inertiaX: 0.0042,
      inertiaY: 0.0072,
      inertiaZ: 0.0038,
      maxThrustToWeight: 8.6,
      motorSpoolUpMs: 14,
      motorSpoolDownMs: 22,
      propWashFactor: 0.38,
      dragFrontArea: 0.048,
      dragTopArea: 0.115,
      groundEffectStrength: 0.80,
      yawTorqueCoeff: 0.052,
    },
  },
  cinewhoop: {
    id: 'cinewhoop',
    label: 'Cinewhoop 3"',
    shortLabel: 'WHOOP',
    tag: 'Indoor / Film',
    description: 'Kompakter 3-Zoll-Ducted-Quad: hoher Luftwiderstand, sanfter Schub, starker Bodeneffekt für enge Linien.',
    engine: {
      flightModel: 'cinewhoop',
      gravityScale: 0.96,
      thrustLinearity: 0.28,
      throttleMid: 0.42,
      throttleExpo: 0.32,
      advanceRatioLoss: 1.1,
      bladeFlapping: 0.25,
      rotationalDrag: 1.5,
    },
    physics: {
      massKg: 0.39,
      armLengthM: 0.075,
      inertiaX: 0.0019,
      inertiaY: 0.0034,
      inertiaZ: 0.0018,
      maxThrustToWeight: 5.4,
      motorSpoolUpMs: 24,
      motorSpoolDownMs: 32,
      propWashFactor: 0.30,
      dragFrontArea: 0.068,
      dragTopArea: 0.165,
      groundEffectStrength: 1.30,
      yawTorqueCoeff: 0.044,
    },
  },
};

export interface PhysicsBackendMeta {
  id: PhysicsBackendId;
  label: string;
  shortLabel: string;
  badge: string;
  description: string;
}

export const PHYSICS_BACKEND_META: Record<PhysicsBackendId, PhysicsBackendMeta> = {
  'custom-euler': {
    id: 'custom-euler',
    label: 'Custom 6-DOF (Euler)',
    shortLabel: 'EULER',
    badge: 'iPad 120 FPS',
    description: 'Zero-GC TypeScript-Solver mit Semi-Implicit Euler. Minimaler Akkuverbrauch & maximale Framerate.',
  },
  'custom-rk4': {
    id: 'custom-rk4',
    label: 'Custom 6-DOF (RK4)',
    shortLabel: 'RK4',
    badge: '4. Ordnung',
    description: 'Runge-Kutta-Integrator 4. Ordnung für extrem präzise High-Rate-Flips (>1000°/s) und Kreiselkräfte.',
  },
  rapier3d: {
    id: 'rapier3d',
    label: 'Rapier3D (WASM)',
    shortLabel: 'RAPIER',
    badge: 'CCD + 3D-Spin',
    description: 'Echte Rust/WebAssembly Rigid-Body-Engine mit Continuous Collision Detection, 3D-Reibung & Drehimpuls-Abprallern.',
  },
};

export const PID_RATE_PRESETS: Record<
  string,
  { label: string; description: string; pid: PidConfig; rates: RatesConfig }
> = {
  freestyle: {
    label: 'Freestyle (Actual 160 / 670)',
    description: 'Präzise Stick-Mitte (160°/s), 670°/s Spitze, Expo 0.54',
    pid: DEFAULT_PID_CONFIG,
    rates: DEFAULT_RATES_CONFIG,
  },
  racing: {
    label: 'Racing (Actual 140 / 560)',
    description: 'Maximale Steifigkeit & Feedforward, 560°/s für Gates',
    pid: {
      roll: { p: 0.72, i: 1.35, d: 0.0082, ff: 0.015 },
      pitch: { p: 0.76, i: 1.40, d: 0.0088, ff: 0.016 },
      yaw: { p: 0.85, i: 1.50, d: 0.0032, ff: 0.012 },
      angleStrength: 8.8,
      angleMaxDeg: 62,
      airmode: true,
    },
    rates: {
      roll: { centerSensitivity: 140, maxRate: 560, expo: 0.48 },
      pitch: { centerSensitivity: 140, maxRate: 560, expo: 0.48 },
      yaw: { centerSensitivity: 130, maxRate: 520, expo: 0.40 },
    },
  },
  beginner: {
    label: 'Training / Einsteiger (Actual 90 / 380)',
    description: 'Ruhige Mitte (90°/s), 380°/s Spitze, sanftes Expo 0.60',
    pid: {
      roll: { p: 0.54, i: 1.05, d: 0.0064, ff: 0.009 },
      pitch: { p: 0.58, i: 1.10, d: 0.0070, ff: 0.010 },
      yaw: { p: 0.65, i: 1.20, d: 0.0025, ff: 0.008 },
      angleStrength: 7.0,
      angleMaxDeg: 40,
      airmode: true,
    },
    rates: {
      roll: { centerSensitivity: 90, maxRate: 380, expo: 0.60 },
      pitch: { centerSensitivity: 90, maxRate: 380, expo: 0.60 },
      yaw: { centerSensitivity: 80, maxRate: 340, expo: 0.50 },
    },
  },
};
