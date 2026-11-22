/**
 * 100% Procedural Web Audio API Synthesizer for 5-inch FPV Quadcopter
 * - 4 independent motor harmonic oscillators (blade-pass frequency + overtone)
 * - Filtered white-noise prop-wash & aerodynamic rush
 * - Authentic BLHeli_32 / DShot ESC startup chime on Arm & gate pass tone
 */
export class DroneAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private motorOscs: OscillatorNode[] = [];
  private motorHarmonics: OscillatorNode[] = [];
  private motorGains: GainNode[] = [];
  private washGain: GainNode | null = null;
  private washFilter: BiquadFilterNode | null = null;
  private initialized = false;
  private enabled = true;

  public unlock(): void {
    if (this.initialized) {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return;
    }

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    try {
      const ctx = new AudioCtx();
      this.ctx = ctx;

      const master = ctx.createGain();
      master.gain.value = this.enabled ? 0.22 : 0;
      master.connect(ctx.destination);
      this.masterGain = master;

      // Motor filter to shape harsh sawtooth/triangle into realistic brushless whine
      const motorBus = ctx.createBiquadFilter();
      motorBus.type = 'lowpass';
      motorBus.frequency.value = 2400;
      motorBus.Q.value = 1.4;
      motorBus.connect(master);

      for (let i = 0; i < 4; i++) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = 120;

        const harm = ctx.createOscillator();
        harm.type = 'triangle';
        harm.frequency.value = 360;

        const g = ctx.createGain();
        g.gain.value = 0;

        const harmGain = ctx.createGain();
        harmGain.gain.value = 0.35;

        osc.connect(g);
        harm.connect(harmGain);
        harmGain.connect(g);
        g.connect(motorBus);

        osc.start();
        harm.start();

        this.motorOscs.push(osc);
        this.motorHarmonics.push(harm);
        this.motorGains.push(g);
      }

      // Prop-wash & airflow turbulence noise generator
      const bufferSize = ctx.sampleRate * 2;
      const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const output = noiseBuffer.getChannelData(0);
      let lastOut = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        output[i] = (lastOut + 0.06 * white) / 1.06;
        lastOut = output[i];
      }

      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;
      noise.loop = true;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 520;
      filter.Q.value = 1.1;

      const wGain = ctx.createGain();
      wGain.gain.value = 0;

      noise.connect(filter);
      filter.connect(wGain);
      wGain.connect(master);
      noise.start();

      this.washFilter = filter;
      this.washGain = wGain;
      this.initialized = true;
    } catch {
      // Ignore if blocked before user interaction
    }
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(enabled ? 0.22 : 0, this.ctx.currentTime, 0.04);
    }
  }

  public update(
    motorSpeeds: readonly [number, number, number, number],
    propWash: number,
    speedMs: number,
    armed: boolean
  ): void {
    if (!this.initialized || !this.ctx || !this.enabled) return;
    const now = this.ctx.currentTime;

    let avg = 0;
    for (let i = 0; i < 4; i++) {
      const s = motorSpeeds[i];
      avg += s * 0.25;
      // 3-blade 5" prop fundamental blade-pass frequency (~140 Hz idle to ~1450 Hz full throttle)
      // Slight per-motor detune creates realistic acoustic beating
      const detune = 1 + (i - 1.5) * 0.012;
      const freq = (95 + s * 1180) * detune;
      this.motorOscs[i].frequency.setTargetAtTime(freq, now, 0.02);
      this.motorHarmonics[i].frequency.setTargetAtTime(freq * 2.02, now, 0.02);

      const targetVol = armed ? Math.min(0.18, 0.025 + s * 0.145) : s * 0.04;
      this.motorGains[i].gain.setTargetAtTime(targetVol, now, 0.025);
    }

    if (this.washGain && this.washFilter) {
      const airNoise = Math.min(0.45, speedMs * 0.008 + avg * 0.16 + propWash * 0.35);
      this.washGain.gain.setTargetAtTime(armed ? airNoise : 0, now, 0.03);
      this.washFilter.frequency.setTargetAtTime(340 + avg * 900 + propWash * 480, now, 0.03);
    }
  }

  public playArmTone(arming: boolean): void {
    if (!this.initialized || !this.ctx || !this.masterGain || !this.enabled) return;
    const now = this.ctx.currentTime;
    const freqs = arming ? [880, 1175, 1568] : [1175, 784];
    freqs.forEach((f, idx) => {
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      g.gain.setValueAtTime(0.001, now + idx * 0.065);
      g.gain.linearRampToValueAtTime(0.24, now + idx * 0.065 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.065 + 0.06);
      osc.connect(g);
      g.connect(this.masterGain!);
      osc.start(now + idx * 0.065);
      osc.stop(now + idx * 0.065 + 0.065);
    });
  }

  public playGateTone(completedLap: boolean): void {
    if (!this.initialized || !this.ctx || !this.masterGain || !this.enabled) return;
    const now = this.ctx.currentTime;
    const notes = completedLap ? [1046, 1318, 1568, 2093] : [987, 1318];
    notes.forEach((f, idx) => {
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      osc.type = 'triangle';
      osc.frequency.value = f;
      g.gain.setValueAtTime(0.001, now + idx * 0.055);
      g.gain.linearRampToValueAtTime(0.28, now + idx * 0.055 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.055 + 0.09);
      osc.connect(g);
      g.connect(this.masterGain!);
      osc.start(now + idx * 0.055);
      osc.stop(now + idx * 0.055 + 0.1);
    });
  }

  public playCrashThud(impactSpeed: number): void {
    if (!this.initialized || !this.ctx || !this.masterGain || !this.enabled) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.exponentialRampToValueAtTime(34, now + 0.18);
    const vol = Math.min(0.7, 0.25 + impactSpeed * 0.03);
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.22);
  }

  public dispose(): void {
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.initialized = false;
  }
}
