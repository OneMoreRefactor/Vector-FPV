import {
  AxisCalibration,
  ControllerConfig,
  ControlInputs,
  StickFunction,
  SwitchMapping,
} from './types';

export interface RawGamepadSnapshot {
  connected: boolean;
  id: string;
  axes: number[];
  buttons: boolean[];
  mappedSticks: ControlInputs;
  armSwitchActive: boolean;
  modeSwitchActive: boolean;
  resetSwitchActive: boolean;
}

export const CONTROLLER_PRESETS: Record<
  string,
  { label: string; subtitle: string; axes: ControllerConfig['axes']; switches: ControllerConfig['switches'] }
> = {
  edgetx_aetr: {
    label: 'EdgeTX / OpenTX (AETR)',
    subtitle: 'RadioMaster, Jumper, FrSky, TBS (Standard USB-Joystick)',
    axes: {
      roll: { axisIndex: 0, inverted: false, deadzone: 0.02, min: -1, center: 0, max: 1 },
      pitch: { axisIndex: 1, inverted: false, deadzone: 0.02, min: -1, center: 0, max: 1 },
      throttle: { axisIndex: 2, inverted: false, deadzone: 0.0, min: -1, center: 0, max: 1 },
      yaw: { axisIndex: 3, inverted: false, deadzone: 0.02, min: -1, center: 0, max: 1 },
    },
    switches: {
      arm: { sourceType: 'axis', index: 4, threshold: 0.1, inverted: false },
      mode: { sourceType: 'axis', index: 5, threshold: 0.1, inverted: false },
      reset: { sourceType: 'axis', index: 6, threshold: 0.1, inverted: false },
    },
  },
  edgetx_taer: {
    label: 'EdgeTX / Spektrum (TAER)',
    subtitle: 'TBS Tango 2 / Mambo TAER Kanalreihenfolge',
    axes: {
      throttle: { axisIndex: 0, inverted: false, deadzone: 0.0, min: -1, center: 0, max: 1 },
      roll: { axisIndex: 1, inverted: false, deadzone: 0.02, min: -1, center: 0, max: 1 },
      pitch: { axisIndex: 2, inverted: false, deadzone: 0.02, min: -1, center: 0, max: 1 },
      yaw: { axisIndex: 3, inverted: false, deadzone: 0.02, min: -1, center: 0, max: 1 },
    },
    switches: {
      arm: { sourceType: 'axis', index: 4, threshold: 0.1, inverted: false },
      mode: { sourceType: 'axis', index: 5, threshold: 0.1, inverted: false },
      reset: { sourceType: 'axis', index: 6, threshold: 0.1, inverted: false },
    },
  },
  dji_fpv: {
    label: 'DJI FPV Controller 2 / 3',
    subtitle: 'USB-C HID-Modus (iPadOS)',
    axes: {
      roll: { axisIndex: 0, inverted: false, deadzone: 0.03, min: -1, center: 0, max: 1 },
      pitch: { axisIndex: 1, inverted: true, deadzone: 0.03, min: -1, center: 0, max: 1 },
      throttle: { axisIndex: 2, inverted: false, deadzone: 0.0, min: -1, center: 0, max: 1 },
      yaw: { axisIndex: 3, inverted: false, deadzone: 0.03, min: -1, center: 0, max: 1 },
    },
    switches: {
      arm: { sourceType: 'button', index: 0, threshold: 0.5, inverted: false },
      mode: { sourceType: 'button', index: 1, threshold: 0.5, inverted: false },
      reset: { sourceType: 'button', index: 2, threshold: 0.5, inverted: false },
    },
  },
  standard_gamepad: {
    label: 'Xbox / PlayStation Controller',
    subtitle: 'Bluetooth Gamepad (Linker Stick: Thr/Yaw, Rechter Stick: Pitch/Roll)',
    axes: {
      yaw: { axisIndex: 0, inverted: false, deadzone: 0.07, min: -1, center: 0, max: 1 },
      throttle: { axisIndex: 1, inverted: true, deadzone: 0.04, min: -1, center: 0, max: 1 },
      roll: { axisIndex: 2, inverted: false, deadzone: 0.07, min: -1, center: 0, max: 1 },
      pitch: { axisIndex: 3, inverted: true, deadzone: 0.07, min: -1, center: 0, max: 1 },
    },
    switches: {
      arm: { sourceType: 'button', index: 0, threshold: 0.5, inverted: false },
      mode: { sourceType: 'button', index: 3, threshold: 0.5, inverted: false },
      reset: { sourceType: 'button', index: 1, threshold: 0.5, inverted: false },
    },
  },
};

/**
 * Applies min/center/max endpoint calibration, inversion, and smooth deadzone.
 * Returns [-1, 1] for centered axes or [0, 1] for throttle.
 */
export function calibrateAxis(raw: number, cal: AxisCalibration, isThrottle: boolean): number {
  const safeMin = Math.min(cal.min, cal.center - 0.05);
  const safeMax = Math.max(cal.max, cal.center + 0.05);

  let norm: number;
  if (isThrottle) {
    // Map [safeMin, safeMax] -> [0, 1]
    norm = (raw - safeMin) / Math.max(0.05, safeMax - safeMin);
    norm = Math.max(0, Math.min(1, norm));
    if (cal.inverted) norm = 1 - norm;
    if (cal.deadzone > 0 && norm < cal.deadzone) norm = 0;
    return norm;
  }

  // Bi-directional centered axis [-1, 1]
  if (raw >= cal.center) {
    norm = (raw - cal.center) / Math.max(0.05, safeMax - cal.center);
  } else {
    norm = (raw - cal.center) / Math.max(0.05, cal.center - safeMin);
  }
  norm = Math.max(-1, Math.min(1, norm));
  if (cal.inverted) norm = -norm;

  // Rescaled deadzone so output begins smoothly from 0 at deadzone edge
  const dz = Math.max(0, Math.min(0.4, cal.deadzone));
  const abs = Math.abs(norm);
  if (abs <= dz) return 0;
  return Math.sign(norm) * ((abs - dz) / (1 - dz));
}

function evaluateSwitch(
  mapping: SwitchMapping,
  axes: readonly number[],
  buttons: readonly GamepadButton[]
): boolean {
  if (mapping.sourceType === 'none') return false;
  let active = false;
  if (mapping.sourceType === 'axis') {
    const v = axes[mapping.index] ?? -1;
    active = v > mapping.threshold;
  } else if (mapping.sourceType === 'button') {
    const btn = buttons[mapping.index];
    active = Boolean(btn && (btn.pressed || btn.value > mapping.threshold));
  }
  return mapping.inverted ? !active : active;
}

export class GamepadController {
  private prevArmSwitch = false;
  private prevModeSwitch = false;
  private prevResetSwitch = false;
  private armToggleState = false;

  public poll(config: ControllerConfig): {
    snapshot: RawGamepadSnapshot;
    armEdge: 'arm' | 'disarm' | null;
    modeToggleEdge: boolean;
    resetEdge: boolean;
  } {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let activePad: Gamepad | null = null;
    for (let i = 0; i < pads.length; i++) {
      if (pads[i] && pads[i]!.connected) {
        activePad = pads[i];
        break;
      }
    }

    if (!activePad) {
      return {
        snapshot: {
          connected: false,
          id: '',
          axes: [0, 0, -1, 0, -1, -1, -1, -1],
          buttons: [],
          mappedSticks: { throttle: 0, roll: 0, pitch: 0, yaw: 0 },
          armSwitchActive: false,
          modeSwitchActive: false,
          resetSwitchActive: false,
        },
        armEdge: null,
        modeToggleEdge: false,
        resetEdge: false,
      };
    }

    const rawAxes: number[] = [];
    const axisCount = Math.max(8, activePad.axes.length);
    for (let i = 0; i < axisCount; i++) {
      rawAxes.push(i < activePad.axes.length ? activePad.axes[i] : 0);
    }

    const rawButtons: boolean[] = [];
    for (let i = 0; i < activePad.buttons.length; i++) {
      rawButtons.push(activePad.buttons[i].pressed || activePad.buttons[i].value > 0.5);
    }

    const getRaw = (fn: StickFunction) => {
      const idx = config.axes[fn].axisIndex;
      return idx >= 0 && idx < activePad!.axes.length ? activePad!.axes[idx] : fn === 'throttle' ? -1 : 0;
    };

    const mappedSticks: ControlInputs = {
      throttle: calibrateAxis(getRaw('throttle'), config.axes.throttle, true),
      roll: calibrateAxis(getRaw('roll'), config.axes.roll, false),
      pitch: calibrateAxis(getRaw('pitch'), config.axes.pitch, false),
      yaw: calibrateAxis(getRaw('yaw'), config.axes.yaw, false),
    };

    const armActive = evaluateSwitch(config.switches.arm, activePad.axes, activePad.buttons);
    const modeActive = evaluateSwitch(config.switches.mode, activePad.axes, activePad.buttons);
    const resetActive = evaluateSwitch(config.switches.reset, activePad.axes, activePad.buttons);

    let armEdge: 'arm' | 'disarm' | null = null;
    if (config.switches.arm.sourceType === 'axis') {
      // Physical 2/3-position RC toggle switch: state directly controls Arm/Disarm on edge
      if (armActive !== this.prevArmSwitch) {
        armEdge = armActive ? 'arm' : 'disarm';
      }
    } else if (config.switches.arm.sourceType === 'button') {
      // Momentary gamepad button: toggle on press
      if (armActive && !this.prevArmSwitch) {
        this.armToggleState = !this.armToggleState;
        armEdge = this.armToggleState ? 'arm' : 'disarm';
      }
    }

    let modeToggleEdge = false;
    if (config.switches.mode.sourceType === 'axis') {
      if (modeActive !== this.prevModeSwitch) modeToggleEdge = true;
    } else if (config.switches.mode.sourceType === 'button') {
      if (modeActive && !this.prevModeSwitch) modeToggleEdge = true;
    }

    const resetEdge = resetActive && !this.prevResetSwitch;

    this.prevArmSwitch = armActive;
    this.prevModeSwitch = modeActive;
    this.prevResetSwitch = resetActive;

    return {
      snapshot: {
        connected: true,
        id: activePad.id,
        axes: rawAxes,
        buttons: rawButtons,
        mappedSticks,
        armSwitchActive: armActive,
        modeSwitchActive: modeActive,
        resetSwitchActive: resetActive,
      },
      armEdge,
      modeToggleEdge,
      resetEdge,
    };
  }
}
