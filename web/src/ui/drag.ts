// Movable windows: drag a box by its handle (its title); where it ends up
// is remembered between visits and kept on screen. Double-click the handle
// to put the box back where it started.

const KEY = 'ascii-sandbox.layout';

function load(): Record<string, { x: number; y: number }> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, { x: number; y: number }>;
  } catch {
    return {};
  }
}

function save(all: Record<string, { x: number; y: number }>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage blocked: positions just aren't remembered
  }
}

/** Forget every remembered position (the "reset layout" command). */
export function resetLayout(): void {
  save({});
  for (const f of resetters) f();
}

const resetters: (() => void)[] = [];

/** Make `el` movable by dragging `handle`; `id` names it in the saved layout. */
export function makeMovable(el: HTMLElement, handle: HTMLElement, id: string): void {
  handle.classList.add('tui-handle');
  handle.title ||= 'drag to move · double-click to put back';
  const place = (x: number, y: number) => {
    const w = el.offsetWidth || 200;
    const nx = Math.max(0, Math.min(window.innerWidth - Math.min(w, 120), x));
    const ny = Math.max(0, Math.min(window.innerHeight - 30, y));
    Object.assign(el.style, { left: `${nx}px`, top: `${ny}px`, right: 'auto', bottom: 'auto', transform: 'none' });
    return { x: nx, y: ny };
  };
  const clear = () => {
    for (const p of ['left', 'top', 'right', 'bottom', 'transform'] as const) el.style[p] = '';
    el.classList.remove('tui-moved');
  };
  resetters.push(clear);
  const saved = load()[id];
  if (saved) {
    // Wait for the box to have a size before keeping it on screen.
    requestAnimationFrame(() => place(saved.x, saved.y));
    el.classList.add('tui-moved');
  }
  // Our own double-click: cancelling the press (no text selection while
  // dragging) also stops the browser's dblclick event.
  let lastDown = 0;
  const putBack = () => {
    const all = load();
    delete all[id];
    save(all);
    clear();
  };
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const now = performance.now();
    if (now - lastDown < 400) {
      lastDown = 0;
      putBack();
      return;
    }
    lastDown = now;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    handle.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      if (Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) < 3) return; // a click, not a drag yet
      lastDown = 0;
      place(m.clientX - dx, m.clientY - dy);
      el.classList.add('tui-moved');
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      const rr = el.getBoundingClientRect();
      if (el.classList.contains('tui-moved')) save({ ...load(), [id]: { x: rr.left, y: rr.top } });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('dblclick', putBack);
  handle.addEventListener('click', (e) => {
    if (e.detail >= 2) putBack();
  });
  window.addEventListener('resize', () => {
    if (el.classList.contains('tui-moved')) {
      const r = el.getBoundingClientRect();
      place(r.left, r.top);
    }
  });
}
