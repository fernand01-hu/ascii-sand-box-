// Player physics for walking through a landscape: gravity, ground following
// on the terrain heightfield, a slope limit, no walking into water, and
// sliding round tree trunks / rocks (vertical cylinders). Pure functions on
// plain data and fixed time steps, so it behaves the same at any frame rate
// and can be tested without a browser.

export interface World {
  /** Heights, row-major (iz * n + ix), over a size x size square centred on 0. */
  heights: Float32Array;
  n: number;
  size: number;
  /** Water surface height, or null. */
  water: number | null;
  /** 1 where the lake is (same grid as heights). */
  waterMask: Uint8Array;
  /** Colliders: x, z, radius, top (y) per entry. */
  colliders: Float32Array;
}

/** What the physics asks about the world (finite scene or streamed chunks). */
export interface Ground {
  /** Ground height, or NaN where the world is not loaded yet. */
  height(x: number, z: number): number;
  isWater(x: number, z: number): boolean;
  /** Inside the playable area (and loaded). */
  inBounds(x: number, z: number): boolean;
  /** Colliders near (x, z): calls `f(x, z, radius, top)` for each. */
  collidersNear(x: number, z: number, f: (cx: number, cz: number, r: number, top: number) => void): void;
  /** Water can be waded through (slowly) instead of blocking the way. */
  wade?: boolean;
  /** What the ground is at (x, z), e.g. "sand" (walking speed depends on it). */
  surface?(x: number, z: number): string;
}

/** Walking speed on each kind of ground (wading water: no running or jumping either). */
export const SURFACE_SPEED: Record<string, number> = { sand: 0.85, rock: 0.95, water: 0.45 };
/** How deep the player stands in water they wade through (m). */
export const WADE_DEPTH = 0.35;

/** Colliders bucketed on a grid, for fast nearby lookups. */
export class ColliderGrid {
  private grid = new Map<number, number[]>();
  readonly c: Float32Array;
  private cell: number;
  constructor(c: Float32Array, cell = 4) {
    this.c = c;
    this.cell = cell;
    for (let i = 0; i + 4 <= c.length; i += 4) {
      const r = c[i + 2]! + PLAYER.radius;
      const x0 = Math.floor((c[i]! - r) / cell), x1 = Math.floor((c[i]! + r) / cell);
      const z0 = Math.floor((c[i + 1]! - r) / cell), z1 = Math.floor((c[i + 1]! + r) / cell);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gz = z0; gz <= z1; gz++) {
          const k = gx * 100003 + gz;
          const list = this.grid.get(k);
          if (list) list.push(i);
          else this.grid.set(k, [i]);
        }
      }
    }
  }
  near(x: number, z: number, f: (cx: number, cz: number, r: number, top: number) => void): void {
    const c = this.c;
    for (const i of this.grid.get(Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell)) ?? []) f(c[i]!, c[i + 1]!, c[i + 2]!, c[i + 3]!);
  }
}

/** A finite scene's heightfield as a Ground. */
export class GridGround implements Ground {
  private colliders: ColliderGrid;
  readonly world: World;
  constructor(world: World) {
    this.world = world;
    this.colliders = new ColliderGrid(world.colliders);
  }
  height(x: number, z: number): number {
    const { n, size, heights } = this.world;
    const half = size / 2;
    const res = size / (n - 1);
    const fx = Math.min(Math.max((x + half) / res, 0), n - 1.001);
    const fz = Math.min(Math.max((z + half) / res, 0), n - 1.001);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const h = (i: number, j: number) => heights[j * n + i]!;
    return (h(ix, iz) * (1 - tx) + h(ix + 1, iz) * tx) * (1 - tz) + (h(ix, iz + 1) * (1 - tx) + h(ix + 1, iz + 1) * tx) * tz;
  }
  isWater(x: number, z: number): boolean {
    const { n, size, waterMask, water } = this.world;
    if (water === null || waterMask.length === 0) return false;
    const res = size / (n - 1);
    const ix = Math.round((x + size / 2) / res), iz = Math.round((z + size / 2) / res);
    if (ix < 0 || iz < 0 || ix >= n || iz >= n) return false;
    return waterMask[iz * n + ix] === 1;
  }
  inBounds(x: number, z: number): boolean {
    const lim = this.world.size / 2 - 2;
    return Math.abs(x) < lim && Math.abs(z) < lim;
  }
  collidersNear(x: number, z: number, f: (cx: number, cz: number, r: number, top: number) => void): void {
    this.colliders.near(x, z, f);
  }
}

export interface PlayerState {
  /** Feet position. */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  onGround: boolean;
  /** View direction: yaw around +y (0 = looking toward -z), pitch up/down. */
  yaw: number;
  pitch: number;
}

export interface Input {
  forward: number; // -1..1
  right: number; // -1..1
  run: boolean;
  jump: boolean;
}

export const PLAYER = {
  radius: 0.35,
  eye: 1.65,
  walk: 4.0,
  run: 8.5,
  jump: 6.2,
  gravity: 20,
  /** Steepest slope you can walk up (rise over run). */
  maxSlope: 1.1,
  /** Steps you can climb without jumping (m). */
  step: 0.45,
  accelGround: 12,
  accelAir: 2.5,
  dt: 1 / 120,
};

export class Physics {
  private acc = 0;

  readonly ground: Ground;
  constructor(ground: Ground) {
    this.ground = ground;
  }

  height(x: number, z: number): number {
    return this.ground.height(x, z);
  }

  isWater(x: number, z: number): boolean {
    return this.ground.isWater(x, z);
  }

  /** Can the player stand at (x, z)? (loaded, inside the world, dry land or water to wade) */
  walkable(x: number, z: number): boolean {
    return this.ground.inBounds(x, z) && Number.isFinite(this.ground.height(x, z)) && (!!this.ground.wade || !this.ground.isWater(x, z));
  }

  /** Is the player wading at (x, z)? */
  wading(x: number, z: number): boolean {
    return !!this.ground.wade && this.ground.isWater(x, z);
  }

  /** A dry, gentle spot near (x, z) to start from. */
  spawn(x: number, z: number, yaw: number): PlayerState {
    for (let r = 0; r < 60; r += 1) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const px = x + r * Math.cos(a), pz = z + r * Math.sin(a);
        if (this.walkable(px, pz) && !this.blocked(px, pz)) {
          return { x: px, y: this.height(px, pz), z: pz, vx: 0, vy: 0, vz: 0, onGround: true, yaw, pitch: -0.1 };
        }
      }
    }
    const h = this.height(x, z);
    return { x, y: Number.isFinite(h) ? h : 0, z, vx: 0, vy: 0, vz: 0, onGround: true, yaw, pitch: -0.1 };
  }

  private blocked(x: number, z: number): boolean {
    let hit = false;
    this.ground.collidersNear(x, z, (cx, cz, r) => {
      if (Math.hypot(x - cx, z - cz) < r + PLAYER.radius) hit = true;
    });
    return hit;
  }

  /** Advance by `dt` seconds of real time, in fixed sub-steps. */
  update(s: PlayerState, input: Input, dt: number): void {
    this.acc += Math.min(dt, 0.25);
    while (this.acc >= PLAYER.dt) {
      this.step(s, input, PLAYER.dt);
      this.acc -= PLAYER.dt;
    }
  }

  step(s: PlayerState, input: Input, dt: number): void {
    // Wish direction from the view yaw (forward = -z at yaw 0).
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
    const rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw);
    let wx = fx * input.forward + rx * input.right;
    let wz = fz * input.forward + rz * input.right;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) {
      wx /= wl;
      wz /= wl;
    }
    const wading = this.wading(s.x, s.z);
    const kind = wading ? 'water' : this.ground.surface?.(s.x, s.z) ?? '';
    const speed = (input.run && !wading ? PLAYER.run : PLAYER.walk) * (SURFACE_SPEED[kind] ?? 1);
    const a = Math.min(1, (s.onGround ? PLAYER.accelGround : PLAYER.accelAir) * dt);
    s.vx += (wx * speed - s.vx) * a;
    s.vz += (wz * speed - s.vz) * a;
    if (input.jump && s.onGround && !wading) {
      s.vy = PLAYER.jump;
      s.onGround = false;
    }
    s.vy -= PLAYER.gravity * dt;

    // Horizontal move, axis by axis so you slide along what blocks you.
    this.moveAxis(s, s.vx * dt, 0);
    this.moveAxis(s, 0, s.vz * dt);
    this.pushOut(s);

    // Vertical: fall, land on the ground (in water, on the bed: knee deep), never below it.
    const g = this.height(s.x, s.z) - (this.wading(s.x, s.z) ? WADE_DEPTH : 0);
    if (!Number.isFinite(g)) {
      s.vy = 0; // the ground here isn't loaded yet: hold still
      return;
    }
    s.y += s.vy * dt;
    if (s.y <= g) {
      s.y = g;
      s.vy = 0;
      s.onGround = true;
    } else if (s.onGround && s.y - g < PLAYER.step && s.vy <= 0) {
      s.y = g; // walking downhill: stay stuck to the ground
      s.vy = 0;
    } else {
      s.onGround = false;
    }
  }

  private moveAxis(s: PlayerState, dx: number, dz: number): void {
    if (dx === 0 && dz === 0) return;
    const nx = s.x + dx, nz = s.z + dz;
    if (!this.walkable(nx, nz)) {
      if (dx !== 0) s.vx = 0;
      if (dz !== 0) s.vz = 0;
      return;
    }
    // Slope limit: only when on the ground and going up.
    if (s.onGround) {
      const rise = this.height(nx, nz) - Math.max(s.y, this.height(s.x, s.z));
      const run = Math.hypot(dx, dz);
      if (rise > PLAYER.step * 0.2 && rise > run * PLAYER.maxSlope) {
        if (dx !== 0) s.vx = 0;
        if (dz !== 0) s.vz = 0;
        return;
      }
    }
    s.x = nx;
    s.z = nz;
  }

  /** Push the player out of trunks and rocks (unless standing on top). */
  private pushOut(s: PlayerState): void {
    this.ground.collidersNear(s.x, s.z, (cx, cz, r, top) => {
      if (s.y > top) return; // above a low rock: no collision
      const dx = s.x - cx, dz = s.z - cz;
      const d = Math.hypot(dx, dz);
      const min = r + PLAYER.radius;
      if (d < min && d > 1e-6) {
        const k = (min - d) / d;
        s.x += dx * k;
        s.z += dz * k;
        // Remove the velocity going into the obstacle.
        const nx = dx / d, nz = dz / d;
        const vn = s.vx * nx + s.vz * nz;
        if (vn < 0) {
          s.vx -= vn * nx;
          s.vz -= vn * nz;
        }
      }
    });
  }
}
