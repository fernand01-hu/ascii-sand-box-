// `window.__ascii`: hooks for the e2e test and the console, in dev and test
// builds only. Thin wrappers over the app's own exports (native/app/src/web.rs).

import type * as App from './app-pkg/ascii_app.js';

type AppModule = typeof App;

/** Average RGBA rows (top first) into a w x h RGB thumbnail, bottom row first (the golden files' order). */
function thumbnail(px: Uint8Array, width: number, height: number, w = 48, h = 36): number[] {
  const sums = new Float64Array(w * h * 3);
  const counts = new Float64Array(w * h);
  for (let y = 0; y < height; y++) {
    const ty = Math.min(h - 1, Math.floor((y * h) / height));
    for (let x = 0; x < width; x++) {
      const tx = Math.min(w - 1, Math.floor((x * w) / width));
      const t = ty * w + tx;
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) sums[t * 3 + c]! += px[i + c]!;
      counts[t]! += 1;
    }
  }
  const out: number[] = [];
  for (let row = h - 1; row >= 0; row--) {
    for (let k = row * w * 3; k < (row + 1) * w * 3; k++) out.push(Math.round(sums[k]! / Math.max(1, counts[Math.floor(k / 3)]!)));
  }
  return out;
}

export function installHooks(app: AppModule, canvas: HTMLCanvasElement): void {
  const grab = async () => {
    const [w, h] = [canvas.width, canvas.height];
    return { px: await app.capture(w, h), w, h };
  };
  const hooks = {
    state: () => app.state(),
    loadModel: (i: number) => app.load_model(i),
    loadGallery: (name: string, seed?: number) => app.load_gallery(name, seed),
    loadScene: (name: string, seed?: number) => app.load_scene(name, seed),
    loadWorld: (seed?: number, day?: boolean) => app.load_world(seed, day),
    loadBytes: (bytes: ArrayBuffer, name: string) => app.load_stl(new Uint8Array(bytes), name),
    setEnvironment: (e: { wind?: number; rain?: number; leaves?: number }) => app.set_environment(e.wind, e.rain, e.leaves),
    freezeTime: (t: number | null) => app.freeze_time(t ?? undefined),
    play: () => app.play(),
    stopPlaying: () => app.stop_playing(),
    travel: (dx: number, dz: number) => app.travel(dx, dz),
    walk: (i: { forward?: number; right?: number; run?: boolean; jump?: boolean; yaw?: number }, seconds: number) =>
      app.walk(i.forward ?? 0, i.right ?? 0, i.run ?? false, i.jump ?? false, i.yaw, seconds),
    /** 48x36 thumbnail of the next frame (bottom row first). */
    thumbnail: async () => {
      const { px, w, h } = await grab();
      return thumbnail(px, w, h);
    },
    /** Fraction of pixels of the next frame that differ from the background. */
    coverage: async () => {
      const { px, w, h } = await grab();
      const bg = (app.state() as { background: number[] }).background.map((c) => c * 255);
      let lit = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (Math.abs(px[i]! - bg[0]!) + Math.abs(px[i + 1]! - bg[1]!) + Math.abs(px[i + 2]! - bg[2]!) > 24) lit++;
      }
      return lit / (w * h);
    },
    /** PNG data URL of the next frame (screenshots from tests). */
    png: async () => {
      const { px, w, h } = await grab();
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0);
      return c.toDataURL('image/png');
    },
  };
  (window as unknown as { __ascii: typeof hooks }).__ascii = hooks;
}
