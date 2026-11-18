// First-person player: keyboard and mouse input, the physics, and the camera.
//
//   WASD / arrows  walk      Shift  run      Space  jump
//   mouse          look (click the view to capture the mouse, Esc to release)

import type { PerspectiveCamera } from 'three';
import { Physics, PLAYER, type Input, type PlayerState, type World } from './physics';

export class Player {
  readonly physics: Physics;
  readonly state: PlayerState;
  private keys = new Set<string>();
  private disposers: (() => void)[] = [];
  /** Mouse look sensitivity, radians per pixel. */
  sensitivity = 0.0022;

  constructor(world: World, start: { x: number; z: number; yaw: number }, private canvas: HTMLCanvasElement) {
    this.physics = new Physics(world);
    this.state = this.physics.spawn(start.x, start.z, start.yaw);
    const on = <K extends keyof WindowEventMap>(t: K, f: (e: WindowEventMap[K]) => void) => {
      window.addEventListener(t, f);
      this.disposers.push(() => window.removeEventListener(t, f));
    };
    on('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    on('keyup', (e) => this.keys.delete(e.code));
    on('blur', () => this.keys.clear());
    on('mousemove', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      this.state.yaw -= e.movementX * this.sensitivity;
      this.state.pitch = Math.max(-1.45, Math.min(1.45, this.state.pitch - e.movementY * this.sensitivity));
    });
    const click = () => {
      if (document.pointerLockElement !== this.canvas) void this.canvas.requestPointerLock?.();
    };
    canvas.addEventListener('click', click);
    this.disposers.push(() => canvas.removeEventListener('click', click));
  }

  input(): Input {
    const k = (...codes: string[]) => codes.some((c) => this.keys.has(c));
    return {
      forward: (k('KeyW', 'ArrowUp') ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 1 : 0),
      right: (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0),
      run: k('ShiftLeft', 'ShiftRight'),
      jump: k('Space'),
    };
  }

  /** Advance the simulation and put the camera at the player's eyes. */
  update(dt: number, camera: PerspectiveCamera, input: Input = this.input()): void {
    this.physics.update(this.state, input, dt);
    this.placeCamera(camera);
  }

  placeCamera(camera: PerspectiveCamera): void {
    const s = this.state;
    camera.position.set(s.x, s.y + PLAYER.eye, s.z);
    camera.rotation.set(s.pitch, s.yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
  }

  dispose(): void {
    this.disposers.forEach((d) => d());
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }
}
