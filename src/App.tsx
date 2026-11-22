import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  ChevronDown,
  ChevronUp,
  Power,
  RotateCcw,
  Sliders,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { FpvOsd } from './components/FpvOsd';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';
import { TouchSticks } from './components/TouchSticks';
import { TuningDrawer } from './components/TuningDrawer';
import { DroneAudioEngine } from './sim/audio';
import { GamepadController, RawGamepadSnapshot } from './sim/gamepad';
import { QuadcopterPhysics } from './sim/physics';
import {
  ControlInputs,
  DEFAULT_SIM_CONFIG,
  SimConfig,
  TelemetrySnapshot,
} from './sim/types';
import { FpvWorld } from './sim/world';

const STORAGE_KEY = 'vektor_fpv_config_v4';
const LEGACY_STORAGE_KEYS = ['vektor_fpv_config_v3', 'vektor_fpv_config_v2', 'vektor_fpv_config_v1'];

function mergeConfig(parsed: Partial<SimConfig>, keepRatesAndPid: boolean): SimConfig {
  return {
    engine: { ...DEFAULT_SIM_CONFIG.engine, ...parsed.engine },
    physics: { ...DEFAULT_SIM_CONFIG.physics, ...parsed.physics },
    pid: keepRatesAndPid
      ? {
          ...DEFAULT_SIM_CONFIG.pid,
          ...parsed.pid,
          roll: { ...DEFAULT_SIM_CONFIG.pid.roll, ...parsed.pid?.roll },
          pitch: { ...DEFAULT_SIM_CONFIG.pid.pitch, ...parsed.pid?.pitch },
          yaw: { ...DEFAULT_SIM_CONFIG.pid.yaw, ...parsed.pid?.yaw },
        }
      : DEFAULT_SIM_CONFIG.pid,
    rates: keepRatesAndPid
      ? {
          roll: { ...DEFAULT_SIM_CONFIG.rates.roll, ...parsed.rates?.roll },
          pitch: { ...DEFAULT_SIM_CONFIG.rates.pitch, ...parsed.rates?.pitch },
          yaw: { ...DEFAULT_SIM_CONFIG.rates.yaw, ...parsed.rates?.yaw },
        }
      : DEFAULT_SIM_CONFIG.rates,
    wind: { ...DEFAULT_SIM_CONFIG.wind, ...parsed.wind },
    camera: { ...DEFAULT_SIM_CONFIG.camera, ...parsed.camera },
    controller: {
      axes: {
        throttle: { ...DEFAULT_SIM_CONFIG.controller.axes.throttle, ...parsed.controller?.axes?.throttle },
        roll: { ...DEFAULT_SIM_CONFIG.controller.axes.roll, ...parsed.controller?.axes?.roll },
        pitch: { ...DEFAULT_SIM_CONFIG.controller.axes.pitch, ...parsed.controller?.axes?.pitch },
        yaw: { ...DEFAULT_SIM_CONFIG.controller.axes.yaw, ...parsed.controller?.axes?.yaw },
      },
      switches: {
        arm: { ...DEFAULT_SIM_CONFIG.controller.switches.arm, ...parsed.controller?.switches?.arm },
        mode: { ...DEFAULT_SIM_CONFIG.controller.switches.mode, ...parsed.controller?.switches?.mode },
        reset: { ...DEFAULT_SIM_CONFIG.controller.switches.reset, ...parsed.controller?.switches?.reset },
      },
      showTouchSticks: parsed.controller?.showTouchSticks ?? DEFAULT_SIM_CONFIG.controller.showTouchSticks,
    },
    audioEnabled: parsed.audioEnabled ?? DEFAULT_SIM_CONFIG.audioEnabled,
  };
}

function loadSavedConfig(): SimConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      for (const key of LEGACY_STORAGE_KEYS) {
        const legacyRaw = localStorage.getItem(key);
        if (legacyRaw) {
          const legacy = JSON.parse(legacyRaw) as Partial<SimConfig>;
          // Preserve Actual Rates & PID from v3; only preserve controller from v1/v2
          return mergeConfig(legacy, key === 'vektor_fpv_config_v3');
        }
      }
      return DEFAULT_SIM_CONFIG;
    }
    const parsed = JSON.parse(raw) as Partial<SimConfig>;
    return mergeConfig(parsed, true);
  } catch {
    return DEFAULT_SIM_CONFIG;
  }
}

const INITIAL_TELEMETRY: TelemetrySnapshot = {
  armed: false,
  crashed: false,
  crashReason: '',
  flightMode: 'ACRO',
  throttlePct: 0,
  speedKmh: 0,
  verticalSpeedMs: 0,
  altitudeM: 0,
  voltageTotal: 25.2,
  voltagePerCell: 4.2,
  voltageSagV: 0,
  currentA: 1.8,
  mahUsed: 0,
  batteryPct: 100,
  flightTimeSec: 0,
  pitchDeg: 0,
  rollDeg: 0,
  headingDeg: 0,
  motorRpm: [0, 0, 0, 0],
  propWashIntensity: 0,
  groundEffectFactor: 1,
  windSpeedMs: 1.8,
  windDirDeg: 35,
  fps: 60,
  pixelRatio: 1,
  activeGateIndex: 0,
  totalGates: 10,
  lapCount: 0,
  currentLapSec: 0,
  bestLapSec: null,
  gamepadConnected: false,
  gamepadName: '',
  controlSource: 'touch',
  activeFlightModel: 'classic-6dof',
  activeBackend: 'custom-euler',
  activeSubstepHz: 400,
  rapierStatus: 'idle',
};

const INITIAL_GAMEPAD: RawGamepadSnapshot = {
  connected: false,
  id: '',
  axes: [0, 0, -1, 0, -1, -1, -1, -1],
  buttons: [],
  mappedSticks: { throttle: 0, roll: 0, pitch: 0, yaw: 0 },
  armSwitchActive: false,
  modeSwitchActive: false,
  resetSwitchActive: false,
};

export default function App() {
  const canvasMountRef = useRef<HTMLDivElement>(null);

  const [config, setConfig] = useState<SimConfig>(loadSavedConfig);
  const configRef = useRef<SimConfig>(config);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerOpenRef = useRef(false);

  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [webglLost, setWebglLost] = useState(false);
  const [touchResetSignal, setTouchResetSignal] = useState(0);

  const [telemetry, setTelemetry] = useState<TelemetrySnapshot>(INITIAL_TELEMETRY);
  const [gamepadSnap, setGamepadSnap] = useState<RawGamepadSnapshot>(INITIAL_GAMEPAD);

  // Core simulation refs (live outside React render cycle for 60-120 FPS + 400 Hz physics)
  const physicsRef = useRef<QuadcopterPhysics>(new QuadcopterPhysics());
  const audioRef = useRef<DroneAudioEngine>(new DroneAudioEngine());
  const gamepadRef = useRef<GamepadController>(new GamepadController());
  const touchSticksRef = useRef<ControlInputs>({ throttle: 0, roll: 0, pitch: 0, yaw: 0 });
  const touchActiveRef = useRef(false);
  const keysRef = useRef<Set<string>>(new Set());
  const keyThrottleRef = useRef(0);

  // Sync configRef, preload selected backend & persist to localStorage
  useEffect(() => {
    configRef.current = config;
    audioRef.current.setEnabled(config.audioEnabled);
    physicsRef.current.prepareBackend(config.engine.backend);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      // Ignore storage quota issues on private browsing
    }
  }, [config]);

  useEffect(() => {
    drawerOpenRef.current = drawerOpen;
  }, [drawerOpen]);

  const unlockAudio = useCallback(() => {
    audioRef.current.unlock();
    audioRef.current.setEnabled(configRef.current.audioEnabled);
  }, []);

  const handleToggleArm = useCallback(() => {
    unlockAudio();
    const phys = physicsRef.current;
    const nextArm = !phys.armed;
    phys.setArmed(nextArm);
    audioRef.current.playArmTone(nextArm);
  }, [unlockAudio]);

  const handleToggleMode = useCallback(() => {
    unlockAudio();
    const phys = physicsRef.current;
    phys.setFlightMode(phys.flightMode === 'ACRO' ? 'ANGLE' : 'ACRO');
  }, [unlockAudio]);

  const handleResetDrone = useCallback(
    (fullBattery = false) => {
      unlockAudio();
      keyThrottleRef.current = 0;
      touchSticksRef.current = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
      setTouchResetSignal((n) => n + 1);
      physicsRef.current.reset(fullBattery);
    },
    [unlockAudio]
  );

  const handleToggleCamera = useCallback(() => {
    setConfig((prev) => ({
      ...prev,
      camera: {
        ...prev.camera,
        viewMode: prev.camera.viewMode === 'FPV' ? 'CHASE' : 'FPV',
      },
    }));
  }, []);

  const handleToggleAudio = useCallback(() => {
    unlockAudio();
    setConfig((prev) => ({ ...prev, audioEnabled: !prev.audioEnabled }));
  }, [unlockAudio]);

  const handleTouchSticksChange = useCallback((sticks: ControlInputs) => {
    touchSticksRef.current = sticks;
  }, []);

  const handleTouchInteraction = useCallback(() => {
    unlockAudio();
    touchActiveRef.current = true;
  }, [unlockAudio]);

  // Keyboard shortcuts & desktop flight fallback
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLSelectElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      const code = e.code;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)) {
        e.preventDefault();
      }
      keysRef.current.add(code);

      if (e.repeat) return;
      if (code === 'Space') {
        handleToggleArm();
      } else if (code === 'KeyM') {
        handleToggleMode();
      } else if (code === 'KeyR') {
        handleResetDrone(false);
      } else if (code === 'KeyC') {
        handleToggleCamera();
      } else if (code === 'KeyH') {
        setDockCollapsed((prev) => !prev);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      keysRef.current.delete(e.code);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [handleResetDrone, handleToggleArm, handleToggleCamera, handleToggleMode]);

  // Mount Three.js WebGL World & Decoupled 400 Hz Physics + Render Loop ONCE
  useEffect(() => {
    const container = canvasMountRef.current;
    if (!container) return;

    const world = new FpvWorld(container);
    const phys = physicsRef.current;
    const audio = audioRef.current;
    const gamepad = gamepadRef.current;

    phys.setWorldData(world.worldData.boxes, world.worldData.cylinders, world.worldData.gates, {
      onGatePass: (_gateId, completedLap) => {
        audio.playGateTone(completedLap);
      },
      onCrash: (impactSpeed) => {
        audio.playCrashThud(impactSpeed);
      },
    });

    const canvas = world.renderer.domElement;
    const onContextLost = (e: Event) => {
      e.preventDefault();
      setWebglLost(true);
    };
    const onContextRestored = () => {
      setWebglLost(false);
    };
    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);

    const onResize = () => {
      world.resize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
    };
    window.addEventListener('resize', onResize);

    let disposed = false;
    let frameId = 0;
    let lastTime = performance.now();
    let lastHudEmit = 0;
    let prevGpConnected = false;

    // Software WebGL GPU fence synchronization to keep headless/software browsers responsive
    const afterDraw = (cb: () => void) => {
      const gl = world.renderer.getContext() as WebGL2RenderingContext;
      const sync = gl && gl.fenceSync ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
      if (sync) gl.flush();
      const poll = () => {
        if (disposed) {
          if (sync) gl.deleteSync(sync);
          return;
        }
        const status = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl.SIGNALED;
        if (status === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    };

    const tick = () => {
      if (disposed) return;

      const now = performance.now();
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;

      const cfg = configRef.current;

      // 1. Poll Hardware RC Controller (HTML5 Gamepad API)
      const gp = gamepad.poll(cfg.controller);
      if (gp.armEdge === 'arm') {
        phys.setArmed(true);
        audio.playArmTone(true);
      } else if (gp.armEdge === 'disarm') {
        phys.setArmed(false);
        audio.playArmTone(false);
      }
      if (gp.modeToggleEdge) {
        phys.setFlightMode(phys.flightMode === 'ACRO' ? 'ANGLE' : 'ACRO');
      }
      if (gp.resetEdge) {
        phys.reset(false);
      }

      // 2. Resolve Active Control Inputs (Priority: Hardware RC > Touch Sticks > Keyboard)
      let controlSource: 'gamepad' | 'touch' | 'keyboard' = 'keyboard';
      const inputs: ControlInputs = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };

      if (gp.snapshot.connected) {
        controlSource = 'gamepad';
        inputs.throttle = gp.snapshot.mappedSticks.throttle;
        inputs.roll = gp.snapshot.mappedSticks.roll;
        inputs.pitch = gp.snapshot.mappedSticks.pitch;
        inputs.yaw = gp.snapshot.mappedSticks.yaw;
      } else {
        const keys = keysRef.current;
        const anyKey =
          keys.has('KeyW') ||
          keys.has('KeyS') ||
          keys.has('KeyA') ||
          keys.has('KeyD') ||
          keys.has('ArrowUp') ||
          keys.has('ArrowDown') ||
          keys.has('ArrowLeft') ||
          keys.has('ArrowRight') ||
          keys.has('KeyI') ||
          keys.has('KeyK') ||
          keys.has('KeyJ') ||
          keys.has('KeyL');

        if (anyKey) {
          touchActiveRef.current = false;
          controlSource = 'keyboard';
          if (keys.has('KeyW')) keyThrottleRef.current = Math.min(1, keyThrottleRef.current + dt * 0.72);
          if (keys.has('KeyS')) keyThrottleRef.current = Math.max(0, keyThrottleRef.current - dt * 0.85);
          inputs.throttle = keyThrottleRef.current;
          inputs.yaw = (keys.has('KeyD') ? 0.65 : 0) - (keys.has('KeyA') ? 0.65 : 0);
          inputs.pitch =
            (keys.has('ArrowUp') || keys.has('KeyI') ? 0.65 : 0) -
            (keys.has('ArrowDown') || keys.has('KeyK') ? 0.65 : 0);
          inputs.roll =
            (keys.has('ArrowRight') || keys.has('KeyL') ? 0.65 : 0) -
            (keys.has('ArrowLeft') || keys.has('KeyJ') ? 0.65 : 0);
        } else if (touchActiveRef.current) {
          controlSource = 'touch';
          inputs.throttle = touchSticksRef.current.throttle;
          inputs.roll = touchSticksRef.current.roll;
          inputs.pitch = touchSticksRef.current.pitch;
          inputs.yaw = touchSticksRef.current.yaw;
        } else {
          controlSource = 'keyboard';
          inputs.throttle = keyThrottleRef.current;
        }
      }

      // 3. Advance 400 Hz Fixed-Timestep 6-DOF Quadcopter Physics
      phys.step(dt, inputs, cfg);

      // 4. Update Procedural Brushless Motor Audio
      audio.update(phys.motorSpeed, phys.propWashIntensity, phys.velocity.length(), phys.armed);

      // 5. Render Three.js Scene
      world.syncAndRender({
        dt,
        dronePos: phys.position,
        droneQuat: phys.quaternion,
        motorSpeeds: phys.motorSpeed,
        armed: phys.armed,
        crashed: phys.crashed,
        activeGateIndex: phys.activeGateIndex,
        windSpeedMs: phys.activeWindSpeedMs,
        windDirDeg: phys.activeWindDirDeg,
        cameraTiltDeg: cfg.camera.tiltDeg,
        cameraFovDeg: cfg.camera.fovDeg,
        fisheyeStrength: cfg.camera.fisheyeStrength,
        viewMode: cfg.camera.viewMode,
        showPropsInFpv: cfg.camera.showPropsInFpv,
        adaptivePixelRatio: cfg.camera.adaptivePixelRatio,
      });

      // 6. Emit Throttled OSD Telemetry & Live Controller Axes to React (~25 Hz)
      if (now - lastHudEmit > 38) {
        lastHudEmit = now;
        setTelemetry(
          phys.getTelemetry(
            inputs.throttle,
            world.measuredFps,
            world.getPixelRatio(),
            gp.snapshot.connected,
            gp.snapshot.id,
            controlSource,
            cfg.physics.batteryCapacityMah
          )
        );
        if (drawerOpenRef.current || gp.snapshot.connected !== prevGpConnected) {
          prevGpConnected = gp.snapshot.connected;
          setGamepadSnap(gp.snapshot);
        }
      }

      if (world.isSoftwareGl) {
        afterDraw(tick);
      } else {
        frameId = requestAnimationFrame(tick);
      }
    };

    if (world.isSoftwareGl) {
      tick();
    } else {
      frameId = requestAnimationFrame(tick);
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      phys.dispose();
      world.dispose();
    };
  }, []);

  const showTouchSticks =
    !drawerOpen &&
    (config.controller.showTouchSticks === 'always' ||
      (config.controller.showTouchSticks === 'auto' && !telemetry.gamepadConnected));

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-zinc-950">
      {/* Dedicated Isolated WebGL Viewport Mount */}
      <div
        ref={canvasMountRef}
        onPointerDown={unlockAudio}
        style={{ touchAction: 'none' }}
        className="absolute inset-0 h-full w-full"
      />

      {/* Graceful WebGL Context Loss Fallback */}
      {webglLost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/95 p-6 text-center">
          <div className="max-w-sm rounded-xl border border-zinc-800 bg-zinc-900 p-6">
            <h1 className="font-display text-lg font-bold text-amber-400">
              WebGL-Kontext unterbrochen
            </h1>
            <p className="mt-2 text-xs text-zinc-400">
              Die 3D-Grafik wird nach der Freigabe durch iPadOS Safari automatisch wiederhergestellt.
            </p>
          </div>
        </div>
      )}

      {/* Authentic FPV On-Screen Display */}
      <FpvOsd
        telemetry={telemetry}
        cameraTiltDeg={config.camera.tiltDeg}
        viewMode={config.camera.viewMode}
      />

      {/* Non-intrusive Offline Status Badge */}
      <OfflineIndicator />

      {/* Multi-Touch Mode 2 On-Screen Gimbals (iPad Air Fallback) */}
      <TouchSticks
        visible={showTouchSticks}
        resetSignal={touchResetSignal}
        onChange={handleTouchSticksChange}
        onActiveInteraction={handleTouchInteraction}
      />

      {/* Collapsible Bottom-Center Flight Control Dock (Zero Viewport Occlusion) */}
      <div className="fixed bottom-4 left-1/2 z-30 flex -translate-x-1/2 flex-col items-center">
        <button
          type="button"
          onClick={() => setDockCollapsed((v) => !v)}
          className="mb-1 flex items-center gap-1 rounded-t-md border border-b-0 border-zinc-700/80 bg-zinc-950/90 px-3 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:text-white"
          aria-label={dockCollapsed ? 'Steuerleiste einblenden' : 'Steuerleiste ausblenden'}
        >
          {dockCollapsed ? (
            <>
              <ChevronUp className="h-3.5 w-3.5" />
              <span>Steuerung</span>
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5" />
              <span>Ausblenden</span>
            </>
          )}
        </button>

        {!dockCollapsed && (
          <div className="flex items-center gap-1.5 rounded-xl border border-zinc-700/80 bg-zinc-950/90 p-1.5 shadow-2xl">
            {/* Primary Action: ARM / DISARM */}
            <button
              type="button"
              onClick={handleToggleArm}
              className={`flex min-h-[42px] items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold whitespace-nowrap transition-colors ${
                telemetry.armed
                  ? 'bg-red-600 text-white hover:bg-red-500'
                  : 'bg-amber-500 text-zinc-950 hover:bg-amber-400'
              }`}
            >
              <Power className="h-3.5 w-3.5 shrink-0" />
              <span>{telemetry.armed ? 'DISARM' : 'ARM'}</span>
            </button>

            {/* Flight Mode: ACRO / ANGLE */}
            <button
              type="button"
              onClick={handleToggleMode}
              className="min-h-[42px] rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono-tech text-xs font-semibold text-zinc-100 whitespace-nowrap transition-colors hover:border-amber-500/60 hover:bg-zinc-800"
            >
              {telemetry.flightMode}
            </button>

            {/* Camera View: FPV / CHASE */}
            <button
              type="button"
              onClick={handleToggleCamera}
              className="flex min-h-[42px] items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 whitespace-nowrap transition-colors hover:bg-zinc-800"
              title="Kameraperspektive wechseln (C)"
            >
              <Camera className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
              <span className="hidden sm:inline">
                {config.camera.viewMode === 'FPV' ? 'FPV' : 'Verfolger'}
              </span>
            </button>

            {/* Instant Crash / Position Reset */}
            <button
              type="button"
              onClick={() => handleResetDrone(false)}
              className="flex min-h-[42px] items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 whitespace-nowrap transition-colors hover:bg-zinc-800"
              title="Drohne zurücksetzen (R)"
            >
              <RotateCcw className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
              <span className="hidden sm:inline">Reset</span>
            </button>

            {/* Audio Toggle */}
            <button
              type="button"
              onClick={handleToggleAudio}
              className="flex h-[42px] w-[42px] items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 transition-colors hover:bg-zinc-800"
              aria-label={config.audioEnabled ? 'Ton stummschalten' : 'Ton aktivieren'}
            >
              {config.audioEnabled ? (
                <Volume2 className="h-4 w-4 text-cyan-400" />
              ) : (
                <VolumeX className="h-4 w-4 text-zinc-500" />
              )}
            </button>

            {/* In-App PWA Install Prompt (auto-hidden when already installed) */}
            <PWAInstallButton variant="dock" />

            {/* Open Tuning, Rates & RC Calibration Menu */}
            <button
              type="button"
              onClick={() => {
                unlockAudio();
                setDrawerOpen(true);
              }}
              className="flex min-h-[42px] items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-semibold text-amber-400 whitespace-nowrap transition-colors hover:border-amber-500/70 hover:bg-zinc-800"
            >
              <Sliders className="h-3.5 w-3.5 shrink-0" />
              <span>Einstellungen</span>
            </button>
          </div>
        )}
      </div>

      {/* Live Tuning, PID & Hardware RC Calibration Drawer */}
      <TuningDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        config={config}
        onChangeConfig={setConfig}
        gamepadSnapshot={gamepadSnap}
        rapierStatus={telemetry.rapierStatus}
        onRechargeBattery={() => handleResetDrone(true)}
        onResetDefaults={() => setConfig(DEFAULT_SIM_CONFIG)}
      />
    </main>
  );
}
