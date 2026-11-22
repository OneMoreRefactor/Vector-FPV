import * as THREE from 'three';
import type * as RapierNS from '@dimforge/rapier3d-compat';
import {
  ColliderBox,
  ColliderCylinder,
  PhysicsEngineConfig,
  QuadPhysicsConfig,
  RapierBackendStatus,
} from './types';

type RapierModule = typeof RapierNS;

let cachedRapier: RapierModule | null = null;
let loadPromise: Promise<RapierModule> | null = null;

async function loadRapierModule(): Promise<RapierModule> {
  if (cachedRapier) return cachedRapier;
  if (!loadPromise) {
    loadPromise = import('@dimforge/rapier3d-compat').then(async (mod) => {
      const RAPIER = (mod.default ?? mod) as RapierModule;
      await RAPIER.init();
      cachedRapier = RAPIER;
      return RAPIER;
    });
  }
  return loadPromise;
}

const _torqueWorld = new THREE.Vector3();
const _angVelWorld = new THREE.Vector3();
const _invQuat = new THREE.Quaternion();
const _prevVel = new THREE.Vector3();
const _prevAngVelWorld = new THREE.Vector3();
const _expectedLinVel = new THREE.Vector3();
const _expectedAngVelWorld = new THREE.Vector3();
const _deltaLin = new THREE.Vector3();
const _deltaAng = new THREE.Vector3();
const _localUp = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _flatQuat = new THREE.Quaternion();

// Reusable plain objects to avoid allocating inside 200-800 Hz substeps
const _vec3A = { x: 0, y: 0, z: 0 };
const _vec3B = { x: 0, y: 0, z: 0 };
const _quatA = { x: 0, y: 0, z: 0, w: 1 };
const _zeroVec = { x: 0, y: 0, z: 0 };
const _identQuat = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Lazy-loaded Rapier3D (Rust/WASM) 3D Rigid-Body & CCD Collision Backend.
 * Receives world forces and body torques from the FPV aero/PID layer and
 * resolves high-speed 3D collisions, restitution, friction, and angular impulse spin.
 */
export class RapierPhysicsBackend {
  private rapier: RapierModule | null = null;
  private world: RapierNS.World | null = null;
  private droneBody: RapierNS.RigidBody | null = null;
  private droneCollider: RapierNS.Collider | null = null;
  private status: RapierBackendStatus = 'idle';

  private boxes: ColliderBox[] = [];
  private cylinders: ColliderCylinder[] = [];
  private terrainFn: ((x: number, z: number) => number) | null = null;

  // Cached mass/material params so we only call WASM setters when values actually change
  private lastMass = -1;
  private lastIx = -1;
  private lastIy = -1;
  private lastIz = -1;
  private lastRestitution = -1;
  private lastFriction = -1;

  public getStatus(): RapierBackendStatus {
    return this.status;
  }

  public isReady(): boolean {
    return this.status === 'ready' && this.world !== null && this.droneBody !== null;
  }

  public setWorldGeometry(
    boxes: ColliderBox[],
    cylinders: ColliderCylinder[],
    terrainFn: (x: number, z: number) => number
  ): void {
    this.boxes = boxes;
    this.cylinders = cylinders;
    this.terrainFn = terrainFn;
    if (this.rapier && this.status === 'ready') {
      this.buildWorld();
    }
  }

  public async ensureLoaded(): Promise<boolean> {
    if (this.isReady()) return true;
    if (this.status === 'loading') return false;

    this.status = 'loading';
    try {
      this.rapier = await loadRapierModule();
      this.buildWorld();
      this.status = 'ready';
      return true;
    } catch (err) {
      console.error('Rapier3D WASM initialization failed:', err);
      this.status = 'error';
      return false;
    }
  }

  private buildWorld(): void {
    if (!this.rapier) return;
    if (this.world) {
      this.world.free();
      this.world = null;
      this.droneBody = null;
      this.droneCollider = null;
    }

    const R = this.rapier;
    // Gravity is applied explicitly in our Aero/Flight layer so gravityScale works uniformly
    const world = new R.World({ x: 0, y: 0, z: 0 });
    world.timestep = 1 / 400;

    // 1. Terrain Heightfield (88x88 cells across 500m x 500m alpine park)
    const nrows = 88;
    const ncols = 88;
    const span = 500;
    const heights = new Float32Array((nrows + 1) * (ncols + 1));
    const getH = this.terrainFn ?? (() => 0);

    for (let c = 0; c <= ncols; c++) {
      const z = -span * 0.5 + (c / ncols) * span;
      for (let r = 0; r <= nrows; r++) {
        const x = -span * 0.5 + (r / nrows) * span;
        // Rapier heightfield expects column-major indexing: c * (nrows + 1) + r
        heights[c * (nrows + 1) + r] = getH(x, z);
      }
    }

    const terrainDesc = R.ColliderDesc.heightfield(nrows, ncols, heights, {
      x: span,
      y: 1.0,
      z: span,
    })
      .setRestitution(0.28)
      .setFriction(0.7);
    world.createCollider(terrainDesc);

    // 2. Static AABB Boxes (Containers, Dive Tower, Gate Frames)
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      const hx = Math.max(0.03, (b.maxX - b.minX) * 0.5);
      const hy = Math.max(0.03, (b.maxY - b.minY) * 0.5);
      const hz = Math.max(0.03, (b.maxZ - b.minZ) * 0.5);
      const cx = (b.minX + b.maxX) * 0.5;
      const cy = (b.minY + b.maxY) * 0.5;
      const cz = (b.minZ + b.maxZ) * 0.5;

      const desc = R.ColliderDesc.cuboid(hx, hy, hz)
        .setTranslation(cx, cy, cz)
        .setRestitution(0.35)
        .setFriction(0.6);
      world.createCollider(desc);
    }

    // 3. Static Cylinders (Tree trunks, Flag poles)
    for (let i = 0; i < this.cylinders.length; i++) {
      const c = this.cylinders[i];
      const hy = Math.max(0.1, (c.maxY - c.minY) * 0.5);
      const cy = (c.minY + c.maxY) * 0.5;
      const desc = R.ColliderDesc.cylinder(hy, Math.max(0.04, c.radius))
        .setTranslation(c.x, cy, c.z)
        .setRestitution(0.4)
        .setFriction(0.55);
      world.createCollider(desc);
    }

    // 4. Dynamic Quadcopter Rigid Body with Continuous Collision Detection (CCD)
    const bodyDesc = R.RigidBodyDesc.dynamic()
      .setTranslation(0, 0.09, 0)
      .setCcdEnabled(true)
      .setCanSleep(false)
      .setLinearDamping(0)
      .setAngularDamping(0);
    const body = world.createRigidBody(bodyDesc);

    // Low-profile 5-inch frame cuboid collider (mass = 0 so explicit inertia tensor dominates)
    const droneColDesc = R.ColliderDesc.cuboid(0.145, 0.055, 0.145)
      .setMass(0)
      .setRestitution(0.32)
      .setFriction(0.65);
    const droneCol = world.createCollider(droneColDesc, body);

    this.world = world;
    this.droneBody = body;
    this.droneCollider = droneCol;
    this.lastMass = -1;
    this.lastRestitution = -1;
    this.lastFriction = -1;
  }

  private applyBodyParameters(p: QuadPhysicsConfig, e: PhysicsEngineConfig): void {
    if (!this.droneBody || !this.droneCollider) return;

    if (
      p.massKg !== this.lastMass ||
      p.inertiaX !== this.lastIx ||
      p.inertiaY !== this.lastIy ||
      p.inertiaZ !== this.lastIz
    ) {
      _vec3A.x = Math.max(0.0005, p.inertiaX);
      _vec3A.y = Math.max(0.0008, p.inertiaY);
      _vec3A.z = Math.max(0.0005, p.inertiaZ);
      this.droneBody.setAdditionalMassProperties(
        Math.max(0.1, p.massKg),
        _zeroVec,
        _vec3A,
        _identQuat,
        true
      );
      this.lastMass = p.massKg;
      this.lastIx = p.inertiaX;
      this.lastIy = p.inertiaY;
      this.lastIz = p.inertiaZ;
    }

    if (e.collisionRestitution !== this.lastRestitution) {
      this.droneCollider.setRestitution(THREE.MathUtils.clamp(e.collisionRestitution, 0.02, 0.9));
      this.lastRestitution = e.collisionRestitution;
    }

    if (e.collisionFriction !== this.lastFriction) {
      this.droneCollider.setFriction(THREE.MathUtils.clamp(e.collisionFriction, 0.05, 1.5));
      this.lastFriction = e.collisionFriction;
    }
  }

  /**
   * Synchronizes the custom physics state into Rapier (used on reset or live backend switch).
   */
  public syncStateToRapier(
    pos: THREE.Vector3,
    vel: THREE.Vector3,
    quat: THREE.Quaternion,
    bodyAngVel: THREE.Vector3,
    p: QuadPhysicsConfig,
    e: PhysicsEngineConfig
  ): void {
    if (!this.droneBody) return;
    this.applyBodyParameters(p, e);

    _vec3A.x = pos.x;
    _vec3A.y = pos.y;
    _vec3A.z = pos.z;
    this.droneBody.setTranslation(_vec3A, true);

    _quatA.x = quat.x;
    _quatA.y = quat.y;
    _quatA.z = quat.z;
    _quatA.w = quat.w;
    this.droneBody.setRotation(_quatA, true);

    _vec3A.x = vel.x;
    _vec3A.y = vel.y;
    _vec3A.z = vel.z;
    this.droneBody.setLinvel(_vec3A, true);

    // Rapier angular velocity is in world frame
    _angVelWorld.copy(bodyAngVel).applyQuaternion(quat);
    _vec3A.x = _angVelWorld.x;
    _vec3A.y = _angVelWorld.y;
    _vec3A.z = _angVelWorld.z;
    this.droneBody.setAngvel(_vec3A, true);
  }

  /**
   * Advances Rapier3D by one fixed substep dt using computed aero world force & body torque.
   * Returns detected collision velocity impulse (m/s) for impact sound triggering.
   */
  public step(
    dt: number,
    forceWorld: THREE.Vector3,
    torqueBody: THREE.Vector3,
    p: QuadPhysicsConfig,
    e: PhysicsEngineConfig,
    outPos: THREE.Vector3,
    outVel: THREE.Vector3,
    outQuat: THREE.Quaternion,
    outBodyAngVel: THREE.Vector3
  ): number {
    if (!this.world || !this.droneBody) return 0;

    this.applyBodyParameters(p, e);

    const body = this.droneBody;
    const prevLin = body.linvel();
    const prevAng = body.angvel();
    _prevVel.set(prevLin.x, prevLin.y, prevLin.z);
    _prevAngVelWorld.set(prevAng.x, prevAng.y, prevAng.z);

    // Expected collision-free linear velocity (for impact detection)
    const invMass = 1 / Math.max(0.1, p.massKg);
    _expectedLinVel.set(
      _prevVel.x + forceWorld.x * invMass * dt,
      _prevVel.y + forceWorld.y * invMass * dt,
      _prevVel.z + forceWorld.z * invMass * dt
    );

    // Transform body torque to world space for Rapier
    const rot = body.rotation();
    outQuat.set(rot.x, rot.y, rot.z, rot.w).normalize();
    _torqueWorld.copy(torqueBody).applyQuaternion(outQuat);

    // Expected approximate collision-free world angular velocity (for spin-factor scaling)
    _expectedAngVelWorld.set(
      _prevAngVelWorld.x + (_torqueWorld.x / Math.max(0.001, p.inertiaX)) * dt,
      _prevAngVelWorld.y + (_torqueWorld.y / Math.max(0.001, p.inertiaY)) * dt,
      _prevAngVelWorld.z + (_torqueWorld.z / Math.max(0.001, p.inertiaZ)) * dt
    );

    // Apply exact impulse for this substep
    _vec3A.x = forceWorld.x * dt;
    _vec3A.y = forceWorld.y * dt;
    _vec3A.z = forceWorld.z * dt;
    body.applyImpulse(_vec3A, true);

    _vec3B.x = _torqueWorld.x * dt;
    _vec3B.y = _torqueWorld.y * dt;
    _vec3B.z = _torqueWorld.z * dt;
    body.applyTorqueImpulse(_vec3B, true);

    this.world.timestep = dt;
    this.world.step();

    // Read updated state from Rapier
    const pos = body.translation();
    const nRot = body.rotation();
    const nVel = body.linvel();
    const nAng = body.angvel();

    outPos.set(pos.x, pos.y, pos.z);
    outQuat.set(nRot.x, nRot.y, nRot.z, nRot.w).normalize();
    outVel.set(nVel.x, nVel.y, nVel.z);
    _angVelWorld.set(nAng.x, nAng.y, nAng.z);

    // Measure sudden velocity delta from contact impulse
    _deltaLin.copy(outVel).sub(_expectedLinVel);
    const impactDelta = _deltaLin.length();

    // Scale collision-induced angular spin by user's collisionSpinFactor
    if (impactDelta > 0.35 && Math.abs(e.collisionSpinFactor - 1.0) > 0.02) {
      _deltaAng.copy(_angVelWorld).sub(_expectedAngVelWorld);
      _angVelWorld.copy(_expectedAngVelWorld).addScaledVector(_deltaAng, e.collisionSpinFactor);
    }

    // Clamp extreme angular rates to keep flight controller well-behaved after fierce bounces
    const maxAng = 35;
    _angVelWorld.x = THREE.MathUtils.clamp(_angVelWorld.x, -maxAng, maxAng);
    _angVelWorld.y = THREE.MathUtils.clamp(_angVelWorld.y, -maxAng, maxAng);
    _angVelWorld.z = THREE.MathUtils.clamp(_angVelWorld.z, -maxAng, maxAng);

    // Soft outer alpine perimeter (235m) & altitude ceiling (165m)
    let correctedPos = false;
    const horizDist = Math.hypot(outPos.x, outPos.z);
    if (horizDist > 235) {
      const nx = outPos.x / horizDist;
      const nz = outPos.z / horizDist;
      outPos.x = nx * 235;
      outPos.z = nz * 235;
      const outV = outVel.x * nx + outVel.z * nz;
      if (outV > 0) {
        outVel.x -= (1 + e.collisionRestitution) * outV * nx;
        outVel.z -= (1 + e.collisionRestitution) * outV * nz;
      }
      correctedPos = true;
    }
    if (outPos.y > 165) {
      outPos.y = 165;
      if (outVel.y > 0) outVel.y = 0;
      correctedPos = true;
    }

    // Exact analytic terrain floor safeguard (bridges discrete heightfield grid interpolation)
    const exactGroundY = (this.terrainFn ? this.terrainFn(outPos.x, outPos.z) : 0) + 0.055;
    if (outPos.y < exactGroundY) {
      outPos.y = exactGroundY;
      if (outVel.y < 0) {
        outVel.y = -outVel.y * e.collisionRestitution;
        if (Math.abs(outVel.y) < 0.12) outVel.y = 0;
      }
      correctedPos = true;
    }

    // Gentle upright skid settling when nearly stopped on ground
    if (outPos.y <= exactGroundY + 0.06 && outVel.lengthSq() < 1.2) {
      _invQuat.copy(outQuat).invert();
      _localUp.copy(_worldUp).applyQuaternion(_invQuat);
      if (_localUp.y > 0.72) {
        const flatYaw = Math.atan2(
          2 * (outQuat.w * outQuat.y + outQuat.x * outQuat.z),
          1 - 2 * (outQuat.y * outQuat.y + outQuat.z * outQuat.z)
        );
        _flatQuat.setFromAxisAngle(_worldUp, flatYaw);
        outQuat.slerp(_flatQuat, Math.min(1, dt * 12));
        _angVelWorld.multiplyScalar(Math.exp(-dt * 10));
        correctedPos = true;
      }
    }

    if (correctedPos || (impactDelta > 0.35 && Math.abs(e.collisionSpinFactor - 1.0) > 0.02)) {
      _vec3A.x = outPos.x;
      _vec3A.y = outPos.y;
      _vec3A.z = outPos.z;
      body.setTranslation(_vec3A, true);

      _quatA.x = outQuat.x;
      _quatA.y = outQuat.y;
      _quatA.z = outQuat.z;
      _quatA.w = outQuat.w;
      body.setRotation(_quatA, true);

      _vec3A.x = outVel.x;
      _vec3A.y = outVel.y;
      _vec3A.z = outVel.z;
      body.setLinvel(_vec3A, true);

      _vec3A.x = _angVelWorld.x;
      _vec3A.y = _angVelWorld.y;
      _vec3A.z = _angVelWorld.z;
      body.setAngvel(_vec3A, true);
    }

    // Convert world angular velocity back into drone body frame for Gyro/PID
    _invQuat.copy(outQuat).invert();
    outBodyAngVel.copy(_angVelWorld).applyQuaternion(_invQuat);

    return impactDelta;
  }

  public dispose(): void {
    if (this.world) {
      this.world.free();
      this.world = null;
      this.droneBody = null;
      this.droneCollider = null;
    }
    this.status = 'idle';
  }
}
