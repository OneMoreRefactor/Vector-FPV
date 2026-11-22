import * as THREE from 'three';
import { RapierPhysicsBackend } from './rapierBackend';
import {
  ColliderBox,
  ColliderCylinder,
  ControlInputs,
  CourseGate,
  FlightMode,
  FlightModelId,
  PhysicsBackendId,
  PhysicsEngineConfig,
  QuadPhysicsConfig,
  RateAxisConfig,
  SimConfig,
  SubstepHz,
  TelemetrySnapshot,
} from './types';

/**
 * Official Actual Rates Curve (Betaflight 4.2+ Standard)
 * Converts normalized stick [-1, 1] into angular velocity setpoint (deg/s)
 * using Center Sensitivity (deg/s), Max Rate (deg/s), and Expo (0..1).
 */
export function computeActualRateDeg(stick: number, cfg: RateAxisConfig): number {
  const absStick = Math.min(1, Math.abs(stick));
  const sign = stick < 0 ? -1 : 1;

  const center = Math.max(10, cfg.centerSensitivity);
  const max = Math.max(center, cfg.maxRate);
  const expo = THREE.MathUtils.clamp(cfg.expo, 0, 1);

  const stickMovement = Math.max(0, max - center);
  const expof = absStick * (Math.pow(absStick, 5) * expo + absStick * (1 - expo));

  return sign * (center * absStick + stickMovement * expof);
}

/**
 * Betaflight-style Throttle Mid & Expo Curve
 * Maps raw throttle [0..1] to shaped throttle [0..1], flattening slope around `mid`
 * for fine altitude/hover resolution while preserving exact 0->0 and 1->1 endpoints.
 */
export function computeThrottleCurve(raw: number, mid: number, expo: number): number {
  const t = THREE.MathUtils.clamp(raw, 0, 1);
  const e = THREE.MathUtils.clamp(expo, 0, 0.85);
  if (e <= 0.0001) return t;
  const m = THREE.MathUtils.clamp(mid, 0.12, 0.75);

  if (t <= m) {
    const u = (m - t) / m; // 1 at bottom, 0 at mid
    const shaped = u * (1 - e) + u * u * u * e;
    return THREE.MathUtils.clamp(m * (1 - shaped), 0, 1);
  }
  const denom = 1 - m;
  const u = (t - m) / denom; // 0 at mid, 1 at top
  const shaped = u * (1 - e) + u * u * u * e;
  return THREE.MathUtils.clamp(m + denom * shaped, 0, 1);
}

/**
 * Deterministic terrain height function shared between physics and 3D terrain mesh.
 * Flat central runway/airfield (radius ~38m), gentle rolling alpine meadow outside.
 */
export function getTerrainHeight(x: number, z: number): number {
  const distFromPad = Math.hypot(x, z);
  const flatBlend = THREE.MathUtils.smoothstep(distFromPad, 34, 95);
  if (flatBlend <= 0.0001) return 0;

  const h1 = Math.sin(x * 0.018) * Math.cos(z * 0.016) * 4.5;
  const h2 = Math.sin(x * 0.043 + 1.3) * Math.sin(z * 0.039 - 0.7) * 1.8;
  const rimBlend = THREE.MathUtils.smoothstep(distFromPad, 130, 260);
  const rimHeight = rimBlend * rimBlend * (28 + Math.sin(Math.atan2(z, x) * 5) * 9);

  return Math.max(0, (h1 + h2 + 4.2) * flatBlend + rimHeight);
}

const GRAVITY = 9.81;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const PROP_RADIUS_M = 0.0635; // 5-inch prop => 2.5" radius = 0.0635 m
const MAX_MOTOR_RPM = 36500; // 6S 1950KV under load
const PROP_INERTIA_J = 0.0000042; // Realistic 3.5g 5" polycarbonate prop + bell inertia (kg*m^2)

// Pre-allocated scratch vectors/quaternions (Zero-GC in 200-800 Hz physics loop)
const _worldUp = new THREE.Vector3(0, 1, 0);
const _invQuat = new THREE.Quaternion();
const _localUp = new THREE.Vector3();
const _windWorld = new THREE.Vector3();
const _airVelWorld = new THREE.Vector3();
const _airVelBody = new THREE.Vector3();
const _dragBody = new THREE.Vector3();
const _thrustBody = new THREE.Vector3();
const _forceWorld = new THREE.Vector3();
const _torqueBody = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _prevPos = new THREE.Vector3();
const _gateNormal = new THREE.Vector3();
const _relPrev = new THREE.Vector3();
const _relCurr = new THREE.Vector3();
const _forwardWorld = new THREE.Vector3();

// Scratch scalars for RK4 rotational & quaternion integration
function eulerAlpha(
  tx: number,
  ty: number,
  tz: number,
  wx: number,
  wy: number,
  wz: number,
  ix: number,
  iy: number,
  iz: number,
  out: [number, number, number]
): void {
  out[0] = (tx - (iz - iy) * wy * wz) / ix;
  out[1] = (ty - (ix - iz) * wz * wx) / iy;
  out[2] = (tz - (iy - ix) * wx * wy) / iz;
}

function quatDeriv(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  wx: number,
  wy: number,
  wz: number,
  out: [number, number, number, number]
): void {
  out[0] = 0.5 * (qw * wx + qy * wz - qz * wy);
  out[1] = 0.5 * (qw * wy + qz * wx - qx * wz);
  out[2] = 0.5 * (qw * wz + qx * wy - qy * wx);
  out[3] = 0.5 * (-qx * wx - qy * wy - qz * wz);
}

const _rkA1: [number, number, number] = [0, 0, 0];
const _rkA2: [number, number, number] = [0, 0, 0];
const _rkA3: [number, number, number] = [0, 0, 0];
const _rkA4: [number, number, number] = [0, 0, 0];
const _rkQ1: [number, number, number, number] = [0, 0, 0, 0];
const _rkQ2: [number, number, number, number] = [0, 0, 0, 0];
const _rkQ3: [number, number, number, number] = [0, 0, 0, 0];
const _rkQ4: [number, number, number, number] = [0, 0, 0, 0];

export class QuadcopterPhysics {
  // 6-DOF Rigid Body State
  public readonly position = new THREE.Vector3(0, 0.09, 0);
  public readonly velocity = new THREE.Vector3(0, 0, 0);
  public readonly quaternion = new THREE.Quaternion();
  public readonly angularVel = new THREE.Vector3(0, 0, 0); // Body frame rad/s (wx=pitch, wy=yaw, wz=roll)

  // Motor normalized angular velocities [0..1] (M1:RR, M2:FR, M3:RL, M4:FL)
  public readonly motorSpeed: [number, number, number, number] = [0, 0, 0, 0];
  public readonly motorTarget: [number, number, number, number] = [0, 0, 0, 0];

  // Flight Controller State
  public armed = false;
  public crashed = false;
  public crashReason = '';
  public flightMode: FlightMode = 'ACRO';

  // Hybrid Engine State
  private readonly rapierBackend = new RapierPhysicsBackend();
  private rapierSynced = false;
  private activeFlightModel: FlightModelId = 'classic-6dof';
  private activeBackend: PhysicsBackendId = 'custom-euler';
  private activeSubstepHz: SubstepHz = 400;

  // PID internal integrators, filtered derivatives & feedforward setpoint tracking
  private pidI = { x: 0, y: 0, z: 0 };
  private prevGyro = { x: 0, y: 0, z: 0 };
  private filteredD = { x: 0, y: 0, z: 0 };
  private prevTargetRate = { x: 0, y: 0, z: 0 };
  private filteredFF = { x: 0, y: 0, z: 0 };

  // LiPo Battery State
  public mahUsed = 0;
  public voltageTotal = 25.2;
  public voltagePerCell = 4.2;
  public voltageSagV = 0;
  public currentA = 0;
  private filteredCurrentA = 0;

  // Aero diagnostics
  public propWashIntensity = 0;
  public groundEffectFactor = 1.0;
  public activeWindSpeedMs = 0;
  public activeWindDirDeg = 0;

  // Timing & Race Circuit
  public simTime = 0;
  public flightTimeSec = 0;
  public activeGateIndex = 0;
  public lapCount = 0;
  public currentLapSec = 0;
  public bestLapSec: number | null = null;
  private lapStarted = false;
  private accumulator = 0;

  // World colliders & gates
  private boxes: ColliderBox[] = [];
  private cylinders: ColliderCylinder[] = [];
  private gates: CourseGate[] = [];
  private onGatePass?: (gateIndex: number, completedLap: boolean) => void;
  private onCrashCallback?: (impactSpeed: number) => void;
  private lastImpactSoundTime = -1;

  // Spawn transform
  private spawnPos = new THREE.Vector3(0, 0.1, 0);
  private spawnYaw = 0;

  constructor() {
    this.reset(true);
  }

  public setWorldData(
    boxes: ColliderBox[],
    cylinders: ColliderCylinder[],
    gates: CourseGate[],
    callbacks?: {
      onGatePass?: (gateIndex: number, completedLap: boolean) => void;
      onCrash?: (impactSpeed: number) => void;
    }
  ): void {
    this.boxes = boxes;
    this.cylinders = cylinders;
    this.gates = gates;
    this.onGatePass = callbacks?.onGatePass;
    this.onCrashCallback = callbacks?.onCrash;
    this.rapierBackend.setWorldGeometry(boxes, cylinders, getTerrainHeight);
    this.rapierSynced = false;
  }

  public prepareBackend(backend: PhysicsBackendId): void {
    if (backend === 'rapier3d' && this.rapierBackend.getStatus() === 'idle') {
      void this.rapierBackend.ensureLoaded().then((ok) => {
        if (ok) {
          this.rapierSynced = false;
        }
      });
    }
  }

  public reset(fullBattery = false): void {
    const groundY = getTerrainHeight(this.spawnPos.x, this.spawnPos.z);
    this.position.set(this.spawnPos.x, groundY + 0.09, this.spawnPos.z);
    this.velocity.set(0, 0, 0);
    this.quaternion.setFromAxisAngle(_worldUp, this.spawnYaw);
    this.angularVel.set(0, 0, 0);

    this.motorSpeed[0] = 0;
    this.motorSpeed[1] = 0;
    this.motorSpeed[2] = 0;
    this.motorSpeed[3] = 0;
    this.motorTarget[0] = 0;
    this.motorTarget[1] = 0;
    this.motorTarget[2] = 0;
    this.motorTarget[3] = 0;

    this.pidI.x = 0;
    this.pidI.y = 0;
    this.pidI.z = 0;
    this.prevGyro.x = 0;
    this.prevGyro.y = 0;
    this.prevGyro.z = 0;
    this.filteredD.x = 0;
    this.filteredD.y = 0;
    this.filteredD.z = 0;
    this.prevTargetRate.x = 0;
    this.prevTargetRate.y = 0;
    this.prevTargetRate.z = 0;
    this.filteredFF.x = 0;
    this.filteredFF.y = 0;
    this.filteredFF.z = 0;

    this.crashed = false;
    this.crashReason = '';
    this.propWashIntensity = 0;
    this.groundEffectFactor = 1.0;
    this.rapierSynced = false;

    if (fullBattery) {
      this.mahUsed = 0;
      this.flightTimeSec = 0;
      this.activeGateIndex = 0;
      this.lapCount = 0;
      this.currentLapSec = 0;
      this.lapStarted = false;
    }
  }

  public setArmed(arm: boolean): void {
    if (arm && this.crashed) {
      this.reset(false);
    }
    if (!arm) {
      this.pidI.x = 0;
      this.pidI.y = 0;
      this.pidI.z = 0;
      this.filteredFF.x = 0;
      this.filteredFF.y = 0;
      this.filteredFF.z = 0;
    }
    this.armed = arm;
  }

  public setFlightMode(mode: FlightMode): void {
    this.flightMode = mode;
  }

  /**
   * Decoupled Fixed-Timestep Accumulator Step (200 / 400 / 800 Hz configurable)
   */
  public step(frameDt: number, inputs: ControlInputs, config: SimConfig): void {
    const engine = config.engine;
    const hz: SubstepHz = engine.substepHz === 200 || engine.substepHz === 800 ? engine.substepHz : 400;
    const fixedDt = 1 / hz;

    this.activeFlightModel = engine.flightModel;
    this.activeSubstepHz = hz;

    if (engine.backend === 'rapier3d') {
      this.prepareBackend('rapier3d');
      if (this.rapierBackend.isReady()) {
        if (this.activeBackend !== 'rapier3d' || !this.rapierSynced) {
          this.rapierBackend.syncStateToRapier(
            this.position,
            this.velocity,
            this.quaternion,
            this.angularVel,
            config.physics,
            engine
          );
          this.rapierSynced = true;
        }
        this.activeBackend = 'rapier3d';
      } else {
        // Seamless fallback while WASM initializes
        this.activeBackend = 'custom-euler';
      }
    } else {
      if (this.activeBackend === 'rapier3d') {
        this.rapierSynced = false;
      }
      this.activeBackend = engine.backend;
    }

    const clampedDt = Math.min(frameDt, 0.05);
    this.accumulator += clampedDt;

    let substeps = 0;
    const maxSubsteps = Math.ceil(hz * 0.055);
    while (this.accumulator >= fixedDt && substeps < maxSubsteps) {
      this.substep(fixedDt, inputs, config);
      this.accumulator -= fixedDt;
      substeps++;
    }
  }

  private substep(dt: number, inputs: ControlInputs, config: SimConfig): void {
    const e = config.engine;
    const p = config.physics;
    const pid = config.pid;
    const rates = config.rates;
    const wind = config.wind;

    this.simTime += dt;
    if (this.armed && !this.crashed) {
      this.flightTimeSec += dt;
      if (this.lapStarted) {
        this.currentLapSec += dt;
      }
    }

    _prevPos.copy(this.position);

    // ---------------------------------------------------------
    // 1. Flight Controller: Actual Rates + Throttle Curve + PID + Feedforward
    // ---------------------------------------------------------
    const idleSpin = 0.075;
    const throttleCmd = computeThrottleCurve(inputs.throttle, e.throttleMid, e.throttleExpo);

    if (this.armed && !this.crashed) {
      let targetWx = 0; // Pitch rate (rad/s, positive = nose up)
      let targetWz = 0; // Roll rate (rad/s, positive = roll left)
      const targetWy = -computeActualRateDeg(inputs.yaw, rates.yaw) * DEG2RAD;

      if (this.flightMode === 'ACRO') {
        targetWx = -computeActualRateDeg(inputs.pitch, rates.pitch) * DEG2RAD;
        targetWz = -computeActualRateDeg(inputs.roll, rates.roll) * DEG2RAD;
      } else {
        _invQuat.copy(this.quaternion).invert();
        _localUp.copy(_worldUp).applyQuaternion(_invQuat);

        const currentPitchDown = Math.atan2(_localUp.z, _localUp.y);
        const currentRollRight = Math.atan2(-_localUp.x, _localUp.y);
        const maxAngleRad = pid.angleMaxDeg * DEG2RAD;

        const desiredPitchDown = inputs.pitch * maxAngleRad;
        const desiredRollRight = inputs.roll * maxAngleRad;

        const pitchErr = desiredPitchDown - currentPitchDown;
        const rollErr = desiredRollRight - currentRollRight;

        const maxRateRad = 540 * DEG2RAD;
        targetWx = THREE.MathUtils.clamp(-pitchErr * pid.angleStrength, -maxRateRad, maxRateRad);
        targetWz = THREE.MathUtils.clamp(-rollErr * pid.angleStrength, -maxRateRad, maxRateRad);
      }

      const errX = targetWx - this.angularVel.x;
      const errY = targetWy - this.angularVel.y;
      const errZ = targetWz - this.angularVel.z;

      const groundH = getTerrainHeight(this.position.x, this.position.z);
      const agl = this.position.y - groundH;
      const onGroundLowThr = agl < 0.16 && throttleCmd < 0.08;

      const relaxX = Math.max(0.1, 1 - Math.abs(targetWx) / 10);
      const relaxY = Math.max(0.15, 1 - Math.abs(targetWy) / 10);
      const relaxZ = Math.max(0.1, 1 - Math.abs(targetWz) / 10);

      if (onGroundLowThr) {
        this.pidI.x *= 0.88;
        this.pidI.y *= 0.88;
        this.pidI.z *= 0.88;
      } else {
        const maxI = 0.45;
        this.pidI.x = THREE.MathUtils.clamp(this.pidI.x + errX * pid.pitch.i * relaxX * dt, -maxI, maxI);
        this.pidI.y = THREE.MathUtils.clamp(this.pidI.y + errY * pid.yaw.i * relaxY * dt, -maxI, maxI);
        this.pidI.z = THREE.MathUtils.clamp(this.pidI.z + errZ * pid.roll.i * relaxZ * dt, -maxI, maxI);
      }

      // D-Term on Measurement + 120 Hz PT1 low-pass filter
      const dAlpha = dt / (dt + 1 / (2 * Math.PI * 120));
      const rawDx = -(this.angularVel.x - this.prevGyro.x) / dt;
      const rawDy = -(this.angularVel.y - this.prevGyro.y) / dt;
      const rawDz = -(this.angularVel.z - this.prevGyro.z) / dt;

      this.filteredD.x += dAlpha * (rawDx - this.filteredD.x);
      this.filteredD.y += dAlpha * (rawDy - this.filteredD.y);
      this.filteredD.z += dAlpha * (rawDz - this.filteredD.z);

      this.prevGyro.x = this.angularVel.x;
      this.prevGyro.y = this.angularVel.y;
      this.prevGyro.z = this.angularVel.z;

      // Feedforward
      const ffAlpha = dt / (dt + 1 / (2 * Math.PI * 45));
      const rawFFx = (targetWx - this.prevTargetRate.x) / dt;
      const rawFFy = (targetWy - this.prevTargetRate.y) / dt;
      const rawFFz = (targetWz - this.prevTargetRate.z) / dt;
      this.filteredFF.x += ffAlpha * (rawFFx - this.filteredFF.x);
      this.filteredFF.y += ffAlpha * (rawFFy - this.filteredFF.y);
      this.filteredFF.z += ffAlpha * (rawFFz - this.filteredFF.z);
      this.prevTargetRate.x = targetWx;
      this.prevTargetRate.y = targetWy;
      this.prevTargetRate.z = targetWz;

      const pidScale = 0.14;
      const uPitch = THREE.MathUtils.clamp(
        (errX * pid.pitch.p +
          this.pidI.x +
          this.filteredD.x * pid.pitch.d +
          this.filteredFF.x * pid.pitch.ff) *
          pidScale,
        -0.82,
        0.82
      );
      const uRoll = THREE.MathUtils.clamp(
        (errZ * pid.roll.p +
          this.pidI.z +
          this.filteredD.z * pid.roll.d +
          this.filteredFF.z * pid.roll.ff) *
          pidScale,
        -0.82,
        0.82
      );
      const uYaw = THREE.MathUtils.clamp(
        (errY * pid.yaw.p +
          this.pidI.y +
          this.filteredD.y * pid.yaw.d +
          this.filteredFF.y * pid.yaw.ff) *
          pidScale *
          0.95,
        -0.36,
        0.36
      );

      const baseThr = idleSpin + throttleCmd * (1 - idleSpin);
      let m0 = baseThr - uPitch + uRoll - uYaw;
      let m1 = baseThr + uPitch + uRoll + uYaw;
      let m2 = baseThr - uPitch - uRoll + uYaw;
      let m3 = baseThr + uPitch - uRoll - uYaw;

      if (pid.airmode && !onGroundLowThr) {
        const minM = Math.min(m0, m1, m2, m3);
        const maxM = Math.max(m0, m1, m2, m3);
        const range = maxM - minM;
        const maxSpan = 1 - idleSpin;
        if (range > maxSpan) {
          const scale = maxSpan / range;
          const mid = (maxM + minM) * 0.5;
          m0 = mid + (m0 - mid) * scale;
          m1 = mid + (m1 - mid) * scale;
          m2 = mid + (m2 - mid) * scale;
          m3 = mid + (m3 - mid) * scale;
        }
        const newMin = Math.min(m0, m1, m2, m3);
        const newMax = Math.max(m0, m1, m2, m3);
        if (newMin < idleSpin) {
          const shift = Math.min(0.22, idleSpin - newMin);
          m0 += shift;
          m1 += shift;
          m2 += shift;
          m3 += shift;
        } else if (newMax > 1) {
          const shift = newMax - 1;
          m0 -= shift;
          m1 -= shift;
          m2 -= shift;
          m3 -= shift;
        }
      }

      this.motorTarget[0] = THREE.MathUtils.clamp(m0, idleSpin, 1);
      this.motorTarget[1] = THREE.MathUtils.clamp(m1, idleSpin, 1);
      this.motorTarget[2] = THREE.MathUtils.clamp(m2, idleSpin, 1);
      this.motorTarget[3] = THREE.MathUtils.clamp(m3, idleSpin, 1);
    } else {
      this.motorTarget[0] = 0;
      this.motorTarget[1] = 0;
      this.motorTarget[2] = 0;
      this.motorTarget[3] = 0;
    }

    // ---------------------------------------------------------
    // 2. LiPo 6S Battery & Voltage Sag Model
    // ---------------------------------------------------------
    const cells = p.batteryCells;
    const capMah = p.batteryCapacityMah;
    const soc = THREE.MathUtils.clamp(1 - this.mahUsed / capMah, 0, 1);

    let ocvCell = 3.5 + 0.7 * soc;
    if (soc > 0.85) {
      ocvCell = 3.92 + ((soc - 0.85) / 0.15) * 0.28;
    } else if (soc > 0.15) {
      ocvCell = 3.68 + ((soc - 0.15) / 0.7) * 0.24;
    } else {
      ocvCell = 3.25 + (soc / 0.15) * 0.43;
    }

    let motorPowerSum = 0;
    for (let i = 0; i < 4; i++) {
      const s = this.motorSpeed[i];
      motorPowerSum += s * s * Math.sqrt(s);
    }
    const instCurrent = 1.8 + (this.armed ? motorPowerSum * 28.5 : 0);
    this.filteredCurrentA += (instCurrent - this.filteredCurrentA) * Math.min(1, dt * 18);
    this.currentA = this.filteredCurrentA;

    const rInternal = 0.021 * (1 + (1 - soc) * 0.45);
    const sagV = p.simulateBattery ? this.currentA * rInternal : 0;
    this.voltageSagV = sagV;

    const nominalFullV = cells * 4.2;
    this.voltageTotal = p.simulateBattery
      ? Math.max(cells * 3.0, cells * ocvCell - sagV)
      : cells * 3.95;
    this.voltagePerCell = this.voltageTotal / cells;

    if (p.simulateBattery && this.armed && !this.crashed) {
      this.mahUsed = Math.min(capMah, this.mahUsed + (this.currentA * dt) / 3.6);
    }

    const voltageScale = THREE.MathUtils.clamp(this.voltageTotal / (nominalFullV * 0.92), 0.72, 1.05);

    // ---------------------------------------------------------
    // 3. Motor Spool-Up / Spool-Down & Propeller Dynamics
    // ---------------------------------------------------------
    const tauUp = Math.max(0.004, p.motorSpoolUpMs * 0.001);
    const tauDown = Math.max(0.006, p.motorSpoolDownMs * 0.001);
    const motorAccel: [number, number, number, number] = [0, 0, 0, 0];

    for (let i = 0; i < 4; i++) {
      const target = this.motorTarget[i] * voltageScale;
      const prev = this.motorSpeed[i];
      const tau = target > prev ? tauUp : tauDown;
      const alpha = 1 - Math.exp(-dt / tau);
      const next = prev + (target - prev) * alpha;
      motorAccel[i] = ((next - prev) / dt) * MAX_MOTOR_RPM * ((2 * Math.PI) / 60);
      this.motorSpeed[i] = next;
    }

    // ---------------------------------------------------------
    // 4. Wind, Airspeed, Ground Effect & Prop-Wash Turbulence
    // ---------------------------------------------------------
    const t = this.simTime;
    const gust =
      wind.gustIntensity *
      (Math.sin(t * 0.73 + this.position.x * 0.04) * 0.55 +
        Math.sin(t * 1.91 + this.position.z * 0.06) * 0.30 +
        Math.cos(t * 3.37) * 0.15);
    const windMag = Math.max(0, wind.speedMs * (1 + gust * 0.85));
    const windRad = (wind.directionDeg + gust * 14) * DEG2RAD;
    this.activeWindSpeedMs = windMag;
    this.activeWindDirDeg = ((wind.directionDeg + gust * 14) % 360 + 360) % 360;

    _windWorld.set(-Math.sin(windRad) * windMag, gust * wind.speedMs * 0.12, Math.cos(windRad) * windMag);

    _airVelWorld.copy(this.velocity).sub(_windWorld);
    _invQuat.copy(this.quaternion).invert();
    _airVelBody.copy(_airVelWorld).applyQuaternion(_invQuat);

    // Cheeseman-Bennett Ground Effect
    const groundY = getTerrainHeight(this.position.x, this.position.z);
    const heightAgl = Math.max(0.06, this.position.y - groundY);
    let geFactor = 1.0;
    if (heightAgl < PROP_RADIUS_M * 14 && p.groundEffectStrength > 0) {
      const ratio = PROP_RADIUS_M / (4 * Math.max(0.09, heightAgl));
      const rawGe = 1 / Math.max(0.74, 1 - ratio * ratio);
      geFactor = 1 + (rawGe - 1) * p.groundEffectStrength;
    }
    this.groundEffectFactor = geFactor;

    // Prop-Wash Turbulence
    const descentBody = Math.max(0, -_airVelBody.y);
    const lateralSpeed = Math.hypot(_airVelBody.x, _airVelBody.z);
    const avgMotor =
      (this.motorSpeed[0] + this.motorSpeed[1] + this.motorSpeed[2] + this.motorSpeed[3]) * 0.25;
    const wakeAlignment = Math.exp(-lateralSpeed * 0.14);
    const rawPropWash =
      THREE.MathUtils.clamp((descentBody - 1.2) / 9.5, 0, 1) *
      wakeAlignment *
      THREE.MathUtils.clamp(avgMotor * 2.2, 0, 1) *
      p.propWashFactor;
    this.propWashIntensity = rawPropWash;

    // ---------------------------------------------------------
    // 5. Aerodynamic Flight Model (Thrust, BEMT Advance-Ratio, Blade Flapping, Drag)
    // ---------------------------------------------------------
    const effGravity = GRAVITY * THREE.MathUtils.clamp(e.gravityScale, 0.7, 1.3);
    const maxTotalThrust = p.massKg * GRAVITY * p.maxThrustToWeight;
    const airDensityRatio = p.airDensity / 1.225;
    const perMotorMaxThrust = (maxTotalThrust / 4) * airDensityRatio;

    // BEMT Advance-Ratio axial inflow thrust loss + Translational Lift in clean forward flight
    const axialInflow = Math.max(-6, _airVelBody.y);
    const advLoss = THREE.MathUtils.clamp(e.advanceRatioLoss, 0, 2);
    const axialFactor = 1 - axialInflow * 0.012 * advLoss;
    // Translational lift: clean airflow across rotor disc boosts efficiency up to ~8% at moderate forward speed
    const translationalLift =
      advLoss > 0.01 ? 1 + Math.min(0.085, (lateralSpeed / 16) * 0.065 * Math.min(1.5, advLoss)) * Math.exp(-lateralSpeed * 0.025) : 1;
    const inflowFactor = THREE.MathUtils.clamp(axialFactor * translationalLift, 0.54, 1.18);
    const propWashLoss = 1 - rawPropWash * 0.14;

    const lin = THREE.MathUtils.clamp(e.thrustLinearity, 0, 0.6);
    const quad = 1 - lin;
    const thrustCurve = (s: number) => lin * s + quad * s * s;

    const T0 = perMotorMaxThrust * thrustCurve(this.motorSpeed[0]) * geFactor * inflowFactor * propWashLoss;
    const T1 = perMotorMaxThrust * thrustCurve(this.motorSpeed[1]) * geFactor * inflowFactor * propWashLoss;
    const T2 = perMotorMaxThrust * thrustCurve(this.motorSpeed[2]) * geFactor * inflowFactor * propWashLoss;
    const T3 = perMotorMaxThrust * thrustCurve(this.motorSpeed[3]) * geFactor * inflowFactor * propWashLoss;

    const totalThrust = T0 + T1 + T2 + T3;
    _thrustBody.set(0, totalThrust, 0);

    // Quadratic Parasitic Drag + Rotor H-Force (linear drag proportional to rotor speed * airspeed)
    const halfRho = 0.5 * p.airDensity;
    const hForceCoeff = 0.014 * THREE.MathUtils.clamp(e.bladeFlapping, 0, 2) * (0.25 + avgMotor * 1.4) * airDensityRatio;
    _dragBody.set(
      -halfRho * p.dragFrontArea * _airVelBody.x * Math.abs(_airVelBody.x) - hForceCoeff * _airVelBody.x,
      -halfRho * p.dragTopArea * _airVelBody.y * Math.abs(_airVelBody.y),
      -halfRho * p.dragFrontArea * _airVelBody.z * Math.abs(_airVelBody.z) - hForceCoeff * _airVelBody.z
    );

    _forceWorld
      .copy(_thrustBody)
      .add(_dragBody)
      .applyQuaternion(this.quaternion);
    _forceWorld.y -= p.massKg * effGravity;

    // Torque in Body Frame (X = Pitch, Y = Yaw, Z = Roll)
    const dArm = p.armLengthM * Math.SQRT1_2;
    let tauX = dArm * (T1 + T3 - T0 - T2);
    let tauZ = dArm * (T0 + T1 - T2 - T3);

    const kYaw = p.yawTorqueCoeff;
    const aeroYaw = kYaw * (T1 + T2 - T0 - T3);
    const inertiaYaw = THREE.MathUtils.clamp(
      PROP_INERTIA_J * (motorAccel[1] + motorAccel[2] - motorAccel[0] - motorAccel[3]),
      -0.18,
      0.18
    );
    let tauY = aeroYaw + inertiaYaw;

    // BEMT Blade-Flapping Aerodynamic Moment (fast forward flight induces subtle pitch-up / side-slip roll-back)
    if (e.bladeFlapping > 0.01 && avgMotor > 0.05) {
      const flapScale = 0.0022 * e.bladeFlapping * (0.35 + avgMotor * 1.35) * airDensityRatio;
      // Forward flight is -Z in body frame => positive pitch-up torque (+X)
      tauX += THREE.MathUtils.clamp(-_airVelBody.z * flapScale, -0.22, 0.22);
      // Rightward side-slip is +X in body frame => roll-left restoring torque (+Z)
      tauZ += THREE.MathUtils.clamp(_airVelBody.x * flapScale * 0.75, -0.18, 0.18);
    }

    // Multi-frequency prop-wash oscillation torques on Roll & Pitch
    if (rawPropWash > 0.02) {
      const pwOscX =
        (Math.sin(t * 47.3) * 0.55 + Math.sin(t * 79.1 + 1.2) * 0.45) * rawPropWash * 0.19;
      const pwOscZ =
        (Math.cos(t * 53.7 + 0.6) * 0.55 + Math.sin(t * 88.4) * 0.45) * rawPropWash * 0.21;
      tauX += pwOscX;
      tauZ += pwOscZ;
    }

    // Rotational aerodynamic damping (scaled by user's rotationalDrag slider)
    const rotMul = THREE.MathUtils.clamp(e.rotationalDrag, 0.2, 2.5);
    const rotDampXY = 0.0028 * rotMul * (1 + avgMotor * 1.4);
    const rotDampYaw = 0.0035 * rotMul * (1 + avgMotor * 1.1);
    tauX -= this.angularVel.x * rotDampXY;
    tauY -= this.angularVel.y * rotDampYaw;
    tauZ -= this.angularVel.z * rotDampXY;

    _torqueBody.set(tauX, tauY, tauZ);

    // ---------------------------------------------------------
    // 6. Rigid-Body Integration & Collision Backend Dispatch
    // ---------------------------------------------------------
    if (this.activeBackend === 'rapier3d' && this.rapierBackend.isReady()) {
      const impactDelta = this.rapierBackend.step(
        dt,
        _forceWorld,
        _torqueBody,
        p,
        e,
        this.position,
        this.velocity,
        this.quaternion,
        this.angularVel
      );
      if (impactDelta > 4.5) {
        this.emitImpactSound(impactDelta);
      }
    } else if (this.activeBackend === 'custom-rk4') {
      this.integrateCustomRK4(dt, p);
      this.resolveCustomCollisions(dt, e);
    } else {
      this.integrateCustomEuler(dt, p);
      this.resolveCustomCollisions(dt, e);
    }

    // ---------------------------------------------------------
    // 7. Racing Gate Traversal Check
    // ---------------------------------------------------------
    this.checkGatePass();
  }

  private integrateCustomEuler(dt: number, p: QuadPhysicsConfig): void {
    const invMass = 1 / p.massKg;
    this.velocity.x += _forceWorld.x * invMass * dt;
    this.velocity.y += _forceWorld.y * invMass * dt;
    this.velocity.z += _forceWorld.z * invMass * dt;

    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.position.z += this.velocity.z * dt;

    const wx = this.angularVel.x;
    const wy = this.angularVel.y;
    const wz = this.angularVel.z;

    const alphaX = (_torqueBody.x - (p.inertiaZ - p.inertiaY) * wy * wz) / p.inertiaX;
    const alphaY = (_torqueBody.y - (p.inertiaX - p.inertiaZ) * wz * wx) / p.inertiaY;
    const alphaZ = (_torqueBody.z - (p.inertiaY - p.inertiaX) * wx * wy) / p.inertiaZ;

    this.angularVel.x = THREE.MathUtils.clamp(wx + alphaX * dt, -35, 35);
    this.angularVel.y = THREE.MathUtils.clamp(wy + alphaY * dt, -30, 30);
    this.angularVel.z = THREE.MathUtils.clamp(wz + alphaZ * dt, -35, 35);

    const qx = this.quaternion.x;
    const qy = this.quaternion.y;
    const qz = this.quaternion.z;
    const qw = this.quaternion.w;

    const dqx = 0.5 * (qw * this.angularVel.x + qy * this.angularVel.z - qz * this.angularVel.y);
    const dqy = 0.5 * (qw * this.angularVel.y + qz * this.angularVel.x - qx * this.angularVel.z);
    const dqz = 0.5 * (qw * this.angularVel.z + qx * this.angularVel.y - qy * this.angularVel.x);
    const dqw = 0.5 * (-qx * this.angularVel.x - qy * this.angularVel.y - qz * this.angularVel.z);

    this.quaternion.set(qx + dqx * dt, qy + dqy * dt, qz + dqz * dt, qw + dqw * dt).normalize();
  }

  /**
   * 4th-Order Runge-Kutta (RK4) Rigid-Body Integrator:
   * Eliminates rotational energy drift & gyroscopic precession error during rapid flips (>1000 deg/s).
   */
  private integrateCustomRK4(dt: number, p: QuadPhysicsConfig): void {
    const invMass = 1 / p.massKg;
    const ax = _forceWorld.x * invMass;
    const ay = _forceWorld.y * invMass;
    const az = _forceWorld.z * invMass;

    // Exact midpoint kinematics for constant acceleration over dt
    this.position.x += this.velocity.x * dt + 0.5 * ax * dt * dt;
    this.position.y += this.velocity.y * dt + 0.5 * ay * dt * dt;
    this.position.z += this.velocity.z * dt + 0.5 * az * dt * dt;
    this.velocity.x += ax * dt;
    this.velocity.y += ay * dt;
    this.velocity.z += az * dt;

    const tx = _torqueBody.x;
    const ty = _torqueBody.y;
    const tz = _torqueBody.z;
    const ix = p.inertiaX;
    const iy = p.inertiaY;
    const iz = p.inertiaZ;

    const wx0 = this.angularVel.x;
    const wy0 = this.angularVel.y;
    const wz0 = this.angularVel.z;
    const qx0 = this.quaternion.x;
    const qy0 = this.quaternion.y;
    const qz0 = this.quaternion.z;
    const qw0 = this.quaternion.w;

    const halfDt = 0.5 * dt;

    // k1
    eulerAlpha(tx, ty, tz, wx0, wy0, wz0, ix, iy, iz, _rkA1);
    quatDeriv(qx0, qy0, qz0, qw0, wx0, wy0, wz0, _rkQ1);

    // k2
    const wx2 = wx0 + _rkA1[0] * halfDt;
    const wy2 = wy0 + _rkA1[1] * halfDt;
    const wz2 = wz0 + _rkA1[2] * halfDt;
    eulerAlpha(tx, ty, tz, wx2, wy2, wz2, ix, iy, iz, _rkA2);
    quatDeriv(
      qx0 + _rkQ1[0] * halfDt,
      qy0 + _rkQ1[1] * halfDt,
      qz0 + _rkQ1[2] * halfDt,
      qw0 + _rkQ1[3] * halfDt,
      wx2,
      wy2,
      wz2,
      _rkQ2
    );

    // k3
    const wx3 = wx0 + _rkA2[0] * halfDt;
    const wy3 = wy0 + _rkA2[1] * halfDt;
    const wz3 = wz0 + _rkA2[2] * halfDt;
    eulerAlpha(tx, ty, tz, wx3, wy3, wz3, ix, iy, iz, _rkA3);
    quatDeriv(
      qx0 + _rkQ2[0] * halfDt,
      qy0 + _rkQ2[1] * halfDt,
      qz0 + _rkQ2[2] * halfDt,
      qw0 + _rkQ2[3] * halfDt,
      wx3,
      wy3,
      wz3,
      _rkQ3
    );

    // k4
    const wx4 = wx0 + _rkA3[0] * dt;
    const wy4 = wy0 + _rkA3[1] * dt;
    const wz4 = wz0 + _rkA3[2] * dt;
    eulerAlpha(tx, ty, tz, wx4, wy4, wz4, ix, iy, iz, _rkA4);
    quatDeriv(
      qx0 + _rkQ3[0] * dt,
      qy0 + _rkQ3[1] * dt,
      qz0 + _rkQ3[2] * dt,
      qw0 + _rkQ3[3] * dt,
      wx4,
      wy4,
      wz4,
      _rkQ4
    );

    const dt6 = dt / 6;
    this.angularVel.x = THREE.MathUtils.clamp(
      wx0 + (_rkA1[0] + 2 * _rkA2[0] + 2 * _rkA3[0] + _rkA4[0]) * dt6,
      -35,
      35
    );
    this.angularVel.y = THREE.MathUtils.clamp(
      wy0 + (_rkA1[1] + 2 * _rkA2[1] + 2 * _rkA3[1] + _rkA4[1]) * dt6,
      -30,
      30
    );
    this.angularVel.z = THREE.MathUtils.clamp(
      wz0 + (_rkA1[2] + 2 * _rkA2[2] + 2 * _rkA3[2] + _rkA4[2]) * dt6,
      -35,
      35
    );

    this.quaternion
      .set(
        qx0 + (_rkQ1[0] + 2 * _rkQ2[0] + 2 * _rkQ3[0] + _rkQ4[0]) * dt6,
        qy0 + (_rkQ1[1] + 2 * _rkQ2[1] + 2 * _rkQ3[1] + _rkQ4[1]) * dt6,
        qz0 + (_rkQ1[2] + 2 * _rkQ2[2] + 2 * _rkQ3[2] + _rkQ4[2]) * dt6,
        qw0 + (_rkQ1[3] + 2 * _rkQ2[3] + 2 * _rkQ3[3] + _rkQ4[3]) * dt6
      )
      .normalize();
  }

  private resolveCustomCollisions(dt: number, e: PhysicsEngineConfig): void {
    const droneRadius = 0.16;
    const restitution = THREE.MathUtils.clamp(e.collisionRestitution, 0.05, 0.85);
    const frictionRate = 6 + THREE.MathUtils.clamp(e.collisionFriction, 0.1, 1.5) * 10;
    const spinFactor = THREE.MathUtils.clamp(e.collisionSpinFactor, 0, 1.5);

    const groundY = getTerrainHeight(this.position.x, this.position.z);
    const minY = groundY + 0.085;

    // Ground contact
    if (this.position.y <= minY) {
      const impactSpeed = -this.velocity.y;
      _invQuat.copy(this.quaternion).invert();
      _localUp.copy(_worldUp).applyQuaternion(_invQuat);
      const uprightDot = _localUp.y;

      this.position.y = minY;

      if (impactSpeed > 6.5) {
        this.emitImpactSound(impactSpeed);
      }

      if (this.velocity.y < 0) {
        this.velocity.y = -this.velocity.y * restitution;
        if (Math.abs(this.velocity.y) < 0.18) this.velocity.y = 0;
      }

      const friction = Math.exp(-dt * frictionRate);
      this.velocity.x *= friction;
      this.velocity.z *= friction;
      this.angularVel.multiplyScalar(Math.exp(-dt * (frictionRate + 2)));

      if (uprightDot > 0.65 && this.velocity.lengthSq() < 1.5) {
        const flatYaw = Math.atan2(
          2 * (this.quaternion.w * this.quaternion.y + this.quaternion.x * this.quaternion.z),
          1 - 2 * (this.quaternion.y * this.quaternion.y + this.quaternion.z * this.quaternion.z)
        );
        _dq.setFromAxisAngle(_worldUp, flatYaw);
        this.quaternion.slerp(_dq, Math.min(1, dt * 16));
      }
    }

    // Soft outer perimeter (235m radius alpine rim)
    const horizDist = Math.hypot(this.position.x, this.position.z);
    if (horizDist > 235) {
      const nx = this.position.x / horizDist;
      const nz = this.position.z / horizDist;
      this.position.x = nx * 235;
      this.position.z = nz * 235;
      const outVel = this.velocity.x * nx + this.velocity.z * nz;
      if (outVel > 0) {
        this.velocity.x -= (1 + restitution) * outVel * nx;
        this.velocity.z -= (1 + restitution) * outVel * nz;
      }
    }
    if (this.position.y > 165) {
      this.position.y = 165;
      if (this.velocity.y > 0) this.velocity.y = 0;
    }

    // AABB Obstacle Collisions
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (
        this.position.x + droneRadius > b.minX &&
        this.position.x - droneRadius < b.maxX &&
        this.position.y + droneRadius > b.minY &&
        this.position.y - droneRadius < b.maxY &&
        this.position.z + droneRadius > b.minZ &&
        this.position.z - droneRadius < b.maxZ
      ) {
        const px1 = this.position.x + droneRadius - b.minX;
        const px2 = b.maxX - (this.position.x - droneRadius);
        const py1 = this.position.y + droneRadius - b.minY;
        const py2 = b.maxY - (this.position.y - droneRadius);
        const pz1 = this.position.z + droneRadius - b.minZ;
        const pz2 = b.maxZ - (this.position.z - droneRadius);

        const minPen = Math.min(px1, px2, py1, py2, pz1, pz2);
        const impactSpeed = this.velocity.length();
        const tangDrag = Math.max(0.45, 1 - e.collisionFriction * 0.25);

        if (minPen === px1) {
          this.position.x = b.minX - droneRadius;
          this.velocity.x = -Math.abs(this.velocity.x) * restitution;
          this.velocity.y *= tangDrag;
          this.velocity.z *= tangDrag;
        } else if (minPen === px2) {
          this.position.x = b.maxX + droneRadius;
          this.velocity.x = Math.abs(this.velocity.x) * restitution;
          this.velocity.y *= tangDrag;
          this.velocity.z *= tangDrag;
        } else if (minPen === py1) {
          this.position.y = b.minY - droneRadius;
          this.velocity.y = -Math.abs(this.velocity.y) * restitution;
          this.velocity.x *= tangDrag;
          this.velocity.z *= tangDrag;
        } else if (minPen === py2) {
          this.position.y = b.maxY + droneRadius;
          this.velocity.y = Math.abs(this.velocity.y) * restitution;
          this.velocity.x *= tangDrag;
          this.velocity.z *= tangDrag;
        } else if (minPen === pz1) {
          this.position.z = b.minZ - droneRadius;
          this.velocity.z = -Math.abs(this.velocity.z) * restitution;
          this.velocity.x *= tangDrag;
          this.velocity.y *= tangDrag;
        } else {
          this.position.z = b.maxZ + droneRadius;
          this.velocity.z = Math.abs(this.velocity.z) * restitution;
          this.velocity.x *= tangDrag;
          this.velocity.y *= tangDrag;
        }

        if (impactSpeed > 2.0 && spinFactor > 0.01) {
          const kick = Math.min(6, impactSpeed * 0.35) * spinFactor;
          this.angularVel.x += (Math.sin(this.simTime * 31.7) * 0.7) * kick;
          this.angularVel.z += (Math.cos(this.simTime * 27.3) * 0.7) * kick;
        }

        if (impactSpeed > 5.0) {
          this.emitImpactSound(impactSpeed);
        }
      }
    }

    // Cylinder Collisions (Tree trunks, Flag poles)
    for (let i = 0; i < this.cylinders.length; i++) {
      const c = this.cylinders[i];
      if (this.position.y + droneRadius < c.minY || this.position.y - droneRadius > c.maxY) continue;
      const dx = this.position.x - c.x;
      const dz = this.position.z - c.z;
      const minDist = c.radius + droneRadius;
      const distSq = dx * dx + dz * dz;
      if (distSq < minDist * minDist && distSq > 1e-6) {
        const dist = Math.sqrt(distSq);
        const nx = dx / dist;
        const nz = dz / dist;
        this.position.x = c.x + nx * minDist;
        this.position.z = c.z + nz * minDist;

        const vn = this.velocity.x * nx + this.velocity.z * nz;
        if (vn < 0) {
          const impactSpeed = -vn;
          this.velocity.x -= (1 + restitution) * vn * nx;
          this.velocity.z -= (1 + restitution) * vn * nz;
          if (spinFactor > 0.01) {
            const spinKick = Math.min(5.5, impactSpeed * 0.4) * spinFactor;
            this.angularVel.x += Math.sin(this.simTime * 43.1) * spinKick;
            this.angularVel.z += Math.cos(this.simTime * 37.9) * spinKick;
          }
          if (impactSpeed > 4.5) {
            this.emitImpactSound(impactSpeed);
          }
        }
      }
    }
  }

  private emitImpactSound(impactSpeed: number): void {
    if (this.simTime - this.lastImpactSoundTime > 0.2) {
      this.lastImpactSoundTime = this.simTime;
      this.onCrashCallback?.(impactSpeed);
    }
  }

  private checkGatePass(): void {
    if (this.gates.length === 0 || !this.armed || this.crashed) return;

    const gate = this.gates[this.activeGateIndex];
    _gateNormal.set(Math.sin(gate.yawRad), 0, Math.cos(gate.yawRad));

    _relPrev.set(_prevPos.x - gate.x, _prevPos.y - gate.y, _prevPos.z - gate.z);
    _relCurr.set(this.position.x - gate.x, this.position.y - gate.y, this.position.z - gate.z);

    const dPrev = _relPrev.dot(_gateNormal);
    const dCurr = _relCurr.dot(_gateNormal);

    if ((dPrev <= 0 && dCurr > 0) || (dPrev >= 0 && dCurr < 0)) {
      const rightX = Math.cos(gate.yawRad);
      const rightZ = -Math.sin(gate.yawRad);
      const localRight = _relCurr.x * rightX + _relCurr.z * rightZ;
      const localUp = _relCurr.y;

      if (Math.abs(localRight) <= gate.width * 0.52 && Math.abs(localUp) <= gate.height * 0.52) {
        let completedLap = false;
        if (!this.lapStarted && this.activeGateIndex === 0) {
          this.lapStarted = true;
          this.currentLapSec = 0;
        }

        const nextGate = (this.activeGateIndex + 1) % this.gates.length;
        if (nextGate === 0 && this.lapStarted) {
          completedLap = true;
          this.lapCount += 1;
          if (this.bestLapSec === null || this.currentLapSec < this.bestLapSec) {
            this.bestLapSec = this.currentLapSec;
          }
          this.currentLapSec = 0;
        }
        this.activeGateIndex = nextGate;
        this.onGatePass?.(gate.id, completedLap);
      }
    }
  }

  public getTelemetry(
    throttleInput: number,
    fps: number,
    pixelRatio: number,
    gamepadConnected: boolean,
    gamepadName: string,
    controlSource: 'gamepad' | 'touch' | 'keyboard',
    batteryCapacityMah: number
  ): TelemetrySnapshot {
    const groundY = getTerrainHeight(this.position.x, this.position.z);
    const altitudeM = Math.max(0, this.position.y - groundY - 0.085);

    _invQuat.copy(this.quaternion).invert();
    _localUp.copy(_worldUp).applyQuaternion(_invQuat);

    const pitchDeg = Math.atan2(-_localUp.z, Math.hypot(_localUp.x, _localUp.y)) * RAD2DEG;
    const rollDeg = Math.atan2(-_localUp.x, _localUp.y) * RAD2DEG;

    _forwardWorld.set(0, 0, -1).applyQuaternion(this.quaternion);
    const headingDeg = ((Math.atan2(_forwardWorld.x, -_forwardWorld.z) * RAD2DEG) % 360 + 360) % 360;

    return {
      armed: this.armed,
      crashed: this.crashed,
      crashReason: this.crashReason,
      flightMode: this.flightMode,
      throttlePct: Math.round(THREE.MathUtils.clamp(throttleInput, 0, 1) * 100),
      speedKmh: this.velocity.length() * 3.6,
      verticalSpeedMs: this.velocity.y,
      altitudeM,
      voltageTotal: this.voltageTotal,
      voltagePerCell: this.voltagePerCell,
      voltageSagV: this.voltageSagV,
      currentA: this.currentA,
      mahUsed: this.mahUsed,
      batteryPct: Math.round(THREE.MathUtils.clamp(1 - this.mahUsed / batteryCapacityMah, 0, 1) * 100),
      flightTimeSec: this.flightTimeSec,
      pitchDeg,
      rollDeg,
      headingDeg,
      motorRpm: [
        Math.round(this.motorSpeed[0] * MAX_MOTOR_RPM),
        Math.round(this.motorSpeed[1] * MAX_MOTOR_RPM),
        Math.round(this.motorSpeed[2] * MAX_MOTOR_RPM),
        Math.round(this.motorSpeed[3] * MAX_MOTOR_RPM),
      ],
      propWashIntensity: this.propWashIntensity,
      groundEffectFactor: this.groundEffectFactor,
      windSpeedMs: this.activeWindSpeedMs,
      windDirDeg: this.activeWindDirDeg,
      fps,
      pixelRatio,
      activeGateIndex: this.activeGateIndex,
      totalGates: this.gates.length,
      lapCount: this.lapCount,
      currentLapSec: this.currentLapSec,
      bestLapSec: this.bestLapSec,
      gamepadConnected,
      gamepadName,
      controlSource,
      activeFlightModel: this.activeFlightModel,
      activeBackend: this.activeBackend,
      activeSubstepHz: this.activeSubstepHz,
      rapierStatus: this.rapierBackend.getStatus(),
    };
  }

  public dispose(): void {
    this.rapierBackend.dispose();
  }
}
