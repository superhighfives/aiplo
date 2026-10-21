import { dist, polylineLength, type Polyline, type Pt } from '../geom';
import { EBB } from './ebb';
import { blocksTime, planPath, type Block } from './motion';

export interface PlotSettings {
  drawSpeed: number; // mm/s
  travelSpeed: number; // mm/s
  accel: number; // mm/s²
  cornering: number; // mm (junction deviation)
  penUp: number; // %
  penDown: number; // %
  /** Servo speed when lifting / lowering, % of the fastest (see SERVO_FULL_SWEEP). */
  penUpSpeed?: number;
  penDownSpeed?: number;
  /** Extra settling time after the servo reaches its position, ms. */
  penUpWait?: number;
  penDownWait?: number;
}

// AxiDraw V3: 2032 steps/inch at 16x microstepping.
const STEPS_PER_MM = 2032 / 25.4;
const MAX_STEP_RATE = 24000; // steps/s per motor (EBB limit is 25k)
const SERVO_MIN = 9855;
const SERVO_MAX = 27831;
const servoPos = (pct: number) => Math.round(SERVO_MIN + ((SERVO_MAX - SERVO_MIN) * pct) / 100);

// The EBB slews the servo at a set rate (SC,11 up / SC,12 down), in pulse-width units
// (83.3 ns) per 24 ms servo cycle. We set it explicitly, so a lift always takes the same,
// known time. 100% speed sweeps the full 0–100% range in SERVO_FULL_SWEEP seconds, about as
// fast as the AxiDraw's pen-lift servo physically moves.
const SERVO_FULL_SWEEP = 0.25;
const SERVO_CYCLE = 0.024;
const servoRate = (speedPct: number) =>
  Math.max(1, Math.round((((SERVO_MAX - SERVO_MIN) * SERVO_CYCLE) / SERVO_FULL_SWEEP) * (Math.max(1, Math.min(100, speedPct)) / 100)));

/** How long a lift (up = true) or drop takes in ms: servo travel at the set speed, plus settling. */
export function liftTime(s: PlotSettings, up: boolean): number {
  const speed = (up ? s.penUpSpeed : s.penDownSpeed) ?? (up ? 60 : 40);
  const wait = (up ? s.penUpWait : s.penDownWait) ?? 100;
  const travel = (Math.abs(servoPos(s.penUp) - servoPos(s.penDown)) / servoRate(speed)) * SERVO_CYCLE * 1000;
  return Math.round(travel + wait);
}

export function estimateTime(paths: Polyline[], s: PlotSettings): number {
  let t = 0;
  let cur: Pt = [0, 0];
  for (const p of paths) {
    if (dist(cur, p[0]) > 0.01) t += blocksTime(planPath([cur, p[0]], s.travelSpeed, s.accel, s.cornering));
    t += blocksTime(planPath(p, s.drawSpeed, s.accel, s.cornering));
    t += (liftTime(s, true) + liftTime(s, false)) / 1000;
    cur = p[p.length - 1];
  }
  return t + blocksTime(planPath([cur, [0, 0]], s.travelSpeed, s.accel, s.cornering));
}

export interface PlotHooks {
  onProgress: (fraction: number, pos: Pt) => void;
  isPaused: () => boolean;
  isStopped: () => boolean;
  waitResume: () => Promise<void>;
}

export class Plotter {
  ebb: EBB | null = null;
  version = '';
  /** Position in integer motor-axis steps (x, y) relative to home. */
  private sx = 0;
  private sy = 0;
  private penIsDown = false;
  busy = false;

  get connected() {
    return !!this.ebb && !this.ebb.closed;
  }
  get pos(): Pt {
    return [this.sx / STEPS_PER_MM, this.sy / STEPS_PER_MM];
  }

  async connect() {
    this.ebb = await EBB.connect();
    this.version = await this.ebb.query('V');
    this.sx = this.sy = 0;
    return this.version;
  }

  private get e() {
    if (!this.connected) throw new Error('Not connected');
    return this.ebb!;
  }

  async configurePen(s: PlotSettings) {
    await this.e.command(`SC,4,${servoPos(s.penUp)}`); // pen-up position
    await this.e.command(`SC,5,${servoPos(s.penDown)}`); // pen-down position
    await this.e.command(`SC,11,${servoRate(s.penUpSpeed ?? 60)}`); // raise speed
    await this.e.command(`SC,12,${servoRate(s.penDownSpeed ?? 40)}`); // lower speed
  }
  // SP's delay holds back the next queued move until the pen has finished moving and settled.
  async penUp(s: PlotSettings) {
    await this.e.command(`SP,1,${liftTime(s, true)}`);
    this.penIsDown = false;
  }
  async penDown(s: PlotSettings) {
    await this.e.command(`SP,0,${liftTime(s, false)}`);
    this.penIsDown = true;
  }
  async motorsOn() {
    await this.e.command('EM,1,1');
  }
  async motorsOff() {
    await this.e.waitIdle();
    await this.e.command('EM,0,0');
    // Position is unknown once the carriage can be pushed by hand.
    this.sx = this.sy = 0;
  }

  /** Streams blocks as SM commands. `progress` receives drawn distance so far. */
  private async sendBlocks(blocks: Block[], hooks?: PlotHooks, s?: PlotSettings, progress?: (travelled: number, pos: Pt) => void) {
    let prev = this.pos;
    let travelled = 0;
    for (const b of blocks) {
      if (hooks?.isStopped()) return false;
      if (hooks?.isPaused() && s) {
        const wasDown = this.penIsDown;
        if (wasDown) await this.penUp(s);
        await hooks.waitResume();
        if (hooks.isStopped()) return false;
        if (wasDown) await this.penDown(s);
      }
      const tx = Math.round(b.x * STEPS_PER_MM);
      const ty = Math.round(b.y * STEPS_PER_MM);
      const dx = tx - this.sx;
      const dy = ty - this.sy;
      if (dx === 0 && dy === 0) continue;
      // CoreXY-style kinematics: motor1 = x + y, motor2 = x - y.
      const m1 = dx + dy;
      const m2 = dx - dy;
      let ms = Math.max(1, Math.round(b.dt * 1000));
      ms = Math.max(ms, Math.ceil((Math.max(Math.abs(m1), Math.abs(m2)) / MAX_STEP_RATE) * 1000));
      await this.e.command(`SM,${ms},${m1},${m2}`);
      this.sx = tx;
      this.sy = ty;
      travelled += dist(prev, [b.x, b.y]);
      prev = [b.x, b.y];
      progress?.(travelled, prev);
    }
    return true;
  }

  async moveTo(target: Pt, s: PlotSettings) {
    await this.motorsOn();
    await this.sendBlocks(planPath([this.pos, target], s.travelSpeed, s.accel, s.cornering));
  }

  async plot(paths: Polyline[], s: PlotSettings, hooks: PlotHooks) {
    if (this.busy) throw new Error('Already plotting');
    this.busy = true;
    try {
      await this.configurePen(s);
      await this.penUp(s);
      await this.motorsOn();
      const total = paths.reduce((t, p) => t + polylineLength(p), 0) || 1;
      let done = 0;
      for (const p of paths) {
        if (hooks.isStopped()) break;
        if (dist(this.pos, p[0]) > 0.05) {
          const travel = planPath([this.pos, p[0]], s.travelSpeed, s.accel, s.cornering);
          const ok = await this.sendBlocks(travel, hooks, s, (_, pos) => hooks.onProgress(done / total, pos));
          if (!ok) break;
        }
        await this.penDown(s);
        const blocks = planPath(p, s.drawSpeed, s.accel, s.cornering);
        const ok = await this.sendBlocks(blocks, hooks, s, (d, pos) => hooks.onProgress((done + d) / total, pos));
        await this.penUp(s);
        if (!ok) break;
        done += polylineLength(p);
      }
      await this.penUp(s);
      await this.sendBlocks(planPath([this.pos, [0, 0]], s.travelSpeed, s.accel, s.cornering));
      await this.e.waitIdle();
      // Only a finished plot is 100%; after a stop, the last progress report is where it got to.
      if (!hooks.isStopped()) hooks.onProgress(1, [0, 0]);
    } finally {
      this.busy = false;
    }
  }
}
