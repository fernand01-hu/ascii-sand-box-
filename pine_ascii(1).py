#!/usr/bin/env python3
"""The procedural pine, built entirely out of ASCII characters.

    python3 pine_ascii.py [seed] [output.png]

Every needle, twig, branch, patch of bark, grass blade, distant tree and bit of
sky is one ASCII character printed on a small flat card that sits in 3D space.
Each card has its own position, orientation (any rotation in 3D), size, colour
and opacity:

  needles   '|' 'l' 'V' 'Y' '/' ...  aligned with the needle, spun randomly
            around it (V and Y look like a pine's two-needle bundles)
  shoot tips '*' '+' 'x'             light new growth
  branches  '=' '#' 'H' '-' '~'      laid along the wood
  bark      '@' '#' '8' / '|' '!' / '~' 's'   plates, fissures, flaky top bark,
            wrapped around the trunk surface and tilted a little off it
  ground    standing grass blades and flat-lying soil marks, in perspective
  forest    small 'A' '^' cards on far planes
  sky       a density ramp ". : - = + * # % @" (darker to brighter), clouds

Lighting is per card: sun with shadows from the crown (rays marched through a
voxel grid of needle density), sky light, light passing through needles from
behind, and a specular glint when a card's angle bounces the sun toward the
camera. Cards are projected with a perspective camera and drawn far to near,
so they overlap and show through one another. No image filter is applied; the
only post step is downscaling the 2x supersampled render for antialiasing.
"""
import math
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import gaussian_filter, gaussian_filter1d, map_coordinates

# ---- scene ------------------------------------------------------------------
W, H = 1300, 1690
SS = 2
TREE_H = 10.0
EYE = 1.6
DIST = 24.0
FOCAL = 3055.0
CX = W / 2
HORIZON = 1345.0
CAM = np.array([0.0, EYE, DIST])
UP = np.array([0.0, 1.0, 0.0])
SUN = np.array([-0.75, 0.33, 0.45])        # low evening sun, front left
SUN /= np.linalg.norm(SUN)
SUN_COL = np.array([1.30, 0.92, 0.58])     # warm
SKY_COL = np.array([0.46, 0.52, 0.80])     # cool
GLINT_COL = np.array([1.0, 0.86, 0.62])
BG = (9, 12, 19)
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"

DENS = 24           # needle-spray characters per unit of shoot length
SIG_SUN = 1.1
SIG_SKY = 0.55

NEEDLE_CH, NEEDLE_P = "VYvy*WwXxKk|/\\li!^A", [12, 10, 8, 6, 6, 4, 4, 3, 3, 2, 2, 6, 6, 6, 3, 3, 3, 4, 3]
TIP_CH = "*+xX"
WOOD_THICK, WOOD_THIN, DEAD_CH = "#=H%&8$", "-=~_", "#%&="
BARK_PLATE, BARK_MID, BARK_FISS, BARK_UP = "@#&8%BMW", "oO0=x", "|!I:[]", "~-=szco<>"
GRASS_CH, GRASS_P = "|/\\'\",;ivwVWYy^`", [12, 9, 9, 6, 5, 4, 3, 5, 7, 6, 4, 2, 6, 4, 3, 2]
SOIL_CH = ".,_-~=:;o"
FOREST_FAR, FOREST_NEAR = "A^*", "A^#%&*"
SKY_RAMP = ".`,:;-~=+*o#%@"


def unit(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def project(p):
    """World points (...,3) -> supersampled screen coords and view distance."""
    d = DIST - p[..., 2]
    return (CX + FOCAL * p[..., 0] / d) * SS, (HORIZON - FOCAL * (p[..., 1] - EYE) / d) * SS, d


def facing_perp(axis, C, rng, twist_sd):
    """Unit vectors perpendicular to `axis` that start out facing the camera and
    are then twisted about the axis by a random angle, so cards turn in 3D but
    mostly stay readable."""
    a = unit(axis)
    u0 = np.cross(a, unit(CAM - C))
    bad = np.linalg.norm(u0, axis=1) < 1e-6
    u0[bad] = np.cross(a[bad], np.array([1.0, 0, 0]))
    u0 = unit(u0)
    tw = rng.normal(0, twist_sd, len(a))[:, None]
    return u0 * np.cos(tw) + np.cross(a, u0) * np.sin(tw)


def perp(v, rng):
    """Random unit vectors perpendicular to each row of v."""
    p = np.cross(v, rng.normal(size=v.shape))
    return p / (np.linalg.norm(p, axis=1, keepdims=True) + 1e-12)


# ---- glyph atlas ------------------------------------------------------------
class Atlas:
    LEVELS = 16

    def __init__(self, chars, th=36):
        font = ImageFont.truetype(FONT, int(th * 0.82))
        tw = int(round(th * 0.6))
        self.TW, self.TH = tw + 4, th + 4           # 2 px empty border
        self.aspect = self.TW / self.TH
        self.index = {c: i for i, c in enumerate(chars)}
        self.cells = []
        for c in chars:
            img = Image.new("L", (self.TW, self.TH), 0)
            ImageDraw.Draw(img).text((self.TW / 2, self.TH / 2), c, fill=255, font=font, anchor="mm")
            self.cells.append([img.point(lambda v, a=a: v * a // (self.LEVELS - 1))
                               for a in range(self.LEVELS)])

    def ids(self, charset, picks):
        return np.array([self.index[charset[k]] for k in picks])


# ---- the tree (same growth model as pine_render.py) -------------------------
class Pine:
    def __init__(self, seed):
        self.rng = np.random.default_rng(seed)
        r = self.rng
        self.ph = r.uniform(0, 2 * np.pi, 5)
        self.crown_base = 2.8 + r.uniform(-0.3, 0.3)
        self.segs, self.tips = [], []
        self.n_p0, self.n_p1, self.n_tint, self.n_young = [], [], [], []
        self.grow()
        self.segs = np.array(self.segs)
        self.n_p0 = np.vstack(self.n_p0)
        self.n_p1 = np.vstack(self.n_p1)
        self.n_tint = np.vstack(self.n_tint)
        self.n_young = np.concatenate(self.n_young)

    def trunk_center(self, y):
        t = np.asarray(y, float) / TREE_H
        ph = self.ph
        x = t * (0.28 * np.sin(1.8 * t + ph[0]) + 0.07 * np.sin(5.5 * t + ph[1]))
        z = t * (0.20 * np.sin(1.4 * t + ph[2]))
        return x, z

    def trunk_radius(self, y):
        y = np.maximum(np.asarray(y, float), 0.0)
        t = np.minimum(y / TREE_H, 1.0)
        return 0.02 + 0.21 * (1 - t) ** 1.15 + 0.11 * np.exp(-y / 0.35)

    def envelope(self, t):
        return 0.3 + 2.75 * (1 - t) ** 0.85 * (0.8 + 0.2 * min(1.0, t / 0.2))

    def grow(self):
        r = self.rng
        whorls, y = [], self.crown_base
        while y < TREE_H - 0.45:
            whorls.append(y)
            y += r.uniform(0.42, 0.75)
        span = TREE_H - self.crown_base
        for yw in whorls:
            t = (yw - self.crown_base) / span
            n = r.integers(4, 8)
            rot = r.uniform(0, 2 * np.pi)
            for j in range(n):
                if r.random() < (0.3 if t < 0.12 else 0.1):
                    continue
                az = rot + 2 * np.pi * j / n + r.normal(0, 0.3)
                yb = yw + r.uniform(-0.05, 0.05)
                cx, cz = self.trunk_center(yb)
                rad = self.trunk_radius(yb)
                base = np.array([cx + 0.7 * rad * math.sin(az), yb, cz + 0.7 * rad * math.cos(az)])
                self.primary(base, az, self.envelope(t) * r.uniform(0.6, 1.18), t)
        ys = np.linspace(TREE_H - 0.65, TREE_H + 0.05, 7)
        cx, cz = self.trunk_center(ys)
        self.needles(np.stack([cx, ys, cz], 1), 0.7)
        for _ in range(r.integers(3, 7)):                 # dead stubs on the bare trunk
            yb = r.uniform(1.2, self.crown_base - 0.1)
            az = r.uniform(0, 2 * np.pi)
            el = r.uniform(-0.3, 0.2)
            L = r.uniform(0.1, 0.4)
            cx, cz = self.trunk_center(yb)
            rad = self.trunk_radius(yb)
            pts = [np.array([cx, yb, cz]) + 0.8 * rad * np.array([math.sin(az), 0, math.cos(az)])]
            for s in np.linspace(0, 1, 4)[1:]:
                e = el - 0.5 * s
                pts.append(pts[-1] + L / 3 * np.array([math.cos(e) * math.sin(az), math.sin(e),
                                                       math.cos(e) * math.cos(az)]))
            self.add_wood(np.array(pts), r.uniform(0.015, 0.026), 0.008, 1, dead=True)

    def primary(self, base, az, L, t):
        r = self.rng
        e0 = -0.12 + 0.8 * t + r.normal(0, 0.1)
        sag = (0.6 * (1 - t) + 0.12) * r.uniform(0.7, 1.3)
        upturn = r.uniform(0.3, 0.75)
        n = max(5, int(L / 0.12))
        pts, a = [base], az
        for i in range(n):
            s = (i + 0.5) / n
            e = e0 - sag * s + upturn * s ** 3
            a += r.normal(0, 0.05)
            pts.append(pts[-1] + (L / n) * np.array([math.cos(e) * math.sin(a), math.sin(e),
                                                     math.cos(e) * math.cos(a)]))
        pts = np.array(pts)
        self.add_wood(pts, 0.022 + 0.022 * L / 2.5, 0.006, 1)
        self.children(pts, L, 1)
        self.needles(pts, r.uniform(0.45, 0.7))

    def shoot(self, p, d, L, level, dead=False):
        r = self.rng
        n = max(2, int(L / 0.1) + 1)
        pts, d = [p], d.copy()
        for i in range(n):
            s = i / n
            d = d + np.array([0, -0.07 * (1 - s) + 0.12 * s * s, 0]) + r.normal(0, 0.06, 3)
            d /= np.linalg.norm(d)
            pts.append(pts[-1] + d * (L / n))
        pts = np.array(pts)
        self.add_wood(pts, 0.005 + 0.01 * min(1.0, L), 0.003, level, dead)
        if dead:
            return
        self.children(pts, L, level)
        self.needles(pts, min(L, r.uniform(0.3, 0.55)) if level == 2 else L)

    def add_wood(self, pts, r0, r1, level, dead=False):
        n = len(pts) - 1
        for i in range(n):
            rr = r0 + (r1 - r0) * (i + 0.5) / n
            self.segs.append((*pts[i], *pts[i + 1], rr, level, float(dead)))

    def children(self, pts, L, level):
        r = self.rng
        if level == 1:
            spacing, s_lo, s_hi = (0.1, 0.17), 0.25, 0.95
        elif level == 2 and L >= 0.25:
            spacing, s_lo, s_hi = (0.08, 0.14), 0.12, 0.9
        else:
            return
        seg = np.diff(pts, axis=0)
        sl = np.linalg.norm(seg, axis=1)
        cum = np.concatenate([[0], np.cumsum(sl)])
        pos = s_lo * L + r.uniform(0, spacing[1])
        while pos < s_hi * L:
            s = pos / L
            i = int(min(np.searchsorted(cum, pos, side="right") - 1, len(seg) - 1))
            p = pts[i] + seg[i] * (pos - cum[i]) / sl[i]
            T = seg[i] / sl[i]
            sv0 = np.cross(T, UP)
            sv0 = sv0 / np.linalg.norm(sv0) if np.linalg.norm(sv0) > 1e-3 else np.array([1.0, 0, 0])
            for sg in (-1, 1):
                if r.random() < (0.1 if level == 1 else 0.3):
                    continue
                roll = r.normal(0, 0.55)
                sv = sv0 * math.cos(roll) + np.cross(T, sv0) * math.sin(roll)
                al = r.uniform(0.55, 1.05)
                dc = unit(T * math.cos(al) + sv * sg * math.sin(al) + UP * r.uniform(-0.1, 0.35))
                if level == 1:
                    Lc = L * 0.38 * (1 - s) ** 0.6 * (0.5 + 0.8 * s) * r.uniform(0.6, 1.15)
                    dead = s < 0.42 and r.random() < 0.55
                else:
                    Lc = L * 0.55 * (1 - s) ** 0.7 * r.uniform(0.6, 1.1)
                    dead = False
                if Lc > 0.08:
                    self.shoot(p, dc, Lc, level + 1, dead)
            if level == 1 and r.random() < 0.25:
                dc = unit(T * 0.5 + UP * 0.85 + sv0 * r.normal(0, 0.3))
                Lc = L * 0.25 * (1 - s) * r.uniform(0.6, 1.0)
                if Lc > 0.1:
                    self.shoot(p, dc, Lc, level + 1)
            pos += r.uniform(*spacing)

    def needles(self, pts, fol):
        r = self.rng
        seg = np.diff(pts, axis=0)
        sl = np.maximum(np.linalg.norm(seg, axis=1), 1e-6)
        cum = np.concatenate([[0], np.cumsum(sl)])
        total = cum[-1]
        fol = min(fol, total)
        cnt = int(DENS * fol + r.random())
        x = r.random(cnt) ** 1.5
        u = total - fol * x
        idx = np.clip(np.searchsorted(cum, u, side="right") - 1, 0, len(seg) - 1)
        base = pts[idx] + seg[idx] * ((u - cum[idx]) / sl[idx])[:, None]
        T = seg[idx] / sl[idx][:, None]
        ref = np.where(np.abs(T[:, 1:2]) > 0.95, np.array([[1.0, 0, 0]]), UP[None])
        B1 = np.cross(T, ref)
        B1 /= np.linalg.norm(B1, axis=1, keepdims=True)
        B2 = np.cross(T, B1)
        psi = r.uniform(0, 2 * np.pi, cnt)
        al = r.uniform(0.55, 1.05, cnt) * (0.45 + 0.55 * np.minimum(1, x / 0.15))
        dv = (T * np.cos(al)[:, None]
              + (B1 * np.cos(psi)[:, None] + B2 * np.sin(psi)[:, None]) * np.sin(al)[:, None])
        dv[:, 1] += 0.22
        dv /= np.linalg.norm(dv, axis=1, keepdims=True)
        ln = r.uniform(0.09, 0.15, cnt) * (1.0 - 0.2 * x)
        self.n_p0.append(base)
        self.n_p1.append(base + dv * ln[:, None])
        self.n_tint.append(np.repeat(r.normal(0, 1, 2)[None], cnt, axis=0))
        self.n_young.append(x < 0.12)
        self.tips.append((pts[-1], seg[-1] / sl[-1]))


# ---- light ------------------------------------------------------------------
class Light:
    """Needle density in a voxel grid; sun / sky transmittance by ray marching."""

    def __init__(self, pts):
        self.cell = 0.2
        self.lo = pts.min(0) - 0.6
        shape = np.ceil((pts.max(0) + 0.6 - self.lo) / self.cell).astype(int) + 1
        g = np.zeros(shape, np.float32)
        np.add.at(g, tuple(((pts - self.lo) / self.cell).astype(int).T), 1.0)
        g = gaussian_filter(g, 0.8)
        self.g = g / np.percentile(g[g > 0.02 * g.max()], 85)
        self.shape = np.array(g.shape)

    def _march(self, P, d, steps, step, sigma):
        acc = np.zeros(len(P), np.float32)
        for k in range(1, steps + 1):
            idx = np.floor((P + d * (k * step) - self.lo) / self.cell).astype(np.int64)
            ok = np.all((idx >= 0) & (idx < self.shape), axis=1)
            acc[ok] += self.g[idx[ok, 0], idx[ok, 1], idx[ok, 2]]
        return np.exp(-sigma * acc * step)

    def sun(self, P):
        return self._march(P, SUN, 18, 0.2, SIG_SUN)

    def sky(self, P):
        dirs = [UP, unit([0.6, 0.8, 0]), unit([-0.6, 0.8, 0]), unit([0, 0.8, 0.6]), unit([0, 0.8, -0.6])]
        return np.mean([self._march(P, d, 9, 0.3, SIG_SKY) for d in dirs], axis=0)


def light_cards(C, U, V, alb, ts, tk, spec_k, shin, trans_k, wrap=0.25):
    """Shade each card from its own normal: wrapped diffuse, see-through light
    from behind, sky light and a Blinn-Phong glint. Returns RGB 0-255 and diffuse."""
    N = unit(np.cross(U, V))
    Vd = unit(CAM - C)
    N *= np.where((N * Vd).sum(1) < 0, -1.0, 1.0)[:, None]   # the side facing the camera
    ndl = N @ SUN
    diff = np.clip((ndl + wrap) / (1 + wrap), 0, 1)
    back = np.clip(-ndl, 0, 1)
    spec = np.clip((N * unit(SUN[None] + Vd)).sum(1), 0, 1) ** shin
    rad = alb * (ts[:, None] * (1.25 * diff + trans_k * back)[:, None] * SUN_COL
                 + 0.5 * tk[:, None] * SKY_COL + 0.03)
    rad = rad + (spec_k * spec * ts)[:, None] * GLINT_COL
    return np.clip((1 - np.exp(-2.2 * rad)) * 255, 0, 255), diff


# ---- cards ------------------------------------------------------------------
class Cards:
    def __init__(self):
        self.parts = []

    def add(self, C, U, V, ch, col, alpha):
        self.parts.append((C, U, V, ch, col, alpha))

    def arrays(self):
        return [np.concatenate(x) for x in zip(*self.parts)]


def needle_cards(tree, light, atlas, rng, cards):
    P0, P1 = tree.n_p0, tree.n_p1
    n = len(P0)
    C = (P0 + P1) / 2
    hgt = rng.uniform(0.14, 0.20, n)            # one character ~ a small spray of needles
    V = unit(P1 - P0) * hgt[:, None]
    C = P0 + V * 0.45
    U = facing_perp(V, C, rng, 0.55) * (hgt * atlas.aspect)[:, None]
    ch = atlas.ids(NEEDLE_CH, rng.choice(len(NEEDLE_CH), n, p=np.array(NEEDLE_P) / sum(NEEDLE_P)))
    t = tree.n_tint
    alb = np.array([0.13, 0.33, 0.17]) * (1 + 0.12 * t[:, 0:1]) + np.array([0.03, 0, -0.03]) * t[:, 1:2]
    alb = np.where(tree.n_young[:, None], alb * 0.4 + np.array([0.26, 0.42, 0.16]) * 0.6, alb)
    alb = np.clip(alb * (1 + 0.15 * rng.normal(size=(n, 1))), 0.02, 1)
    ts, tk = light.sun(C), light.sky(C)
    col, diff = light_cards(C, U, V, alb, ts, tk, spec_k=0.45, shin=28, trans_k=0.45)
    alpha = np.clip(0.28 + 0.8 * ts * diff + 0.1 * rng.random(n), 0.28, 1.0)   # lit = crisp
    cards.add(C, U, V, ch, col, alpha)

    # light new growth at the shoot tips
    keep = rng.random(len(tree.tips)) < 0.4
    tp = np.array([p for p, _ in tree.tips])[keep]
    td = np.array([d for _, d in tree.tips])[keep]
    m = len(tp)
    C = tp + td * 0.02
    V = unit(td + np.array([0, 0.3, 0])) * 0.13
    U = facing_perp(V, C, rng, 0.5) * 0.13 * atlas.aspect
    alb = np.tile([0.36, 0.5, 0.2], (m, 1))
    ts, tk = light.sun(C), light.sky(C)
    col, _ = light_cards(C, U, V, alb, ts, tk, 0.4, 20, 0.5)
    cards.add(C, U, V, atlas.ids(TIP_CH, rng.integers(0, len(TIP_CH), m)), col, np.full(m, 0.85))


def wood_cards(tree, light, atlas, rng, cards):
    s = tree.segs
    s = s[(s[:, 7] < 3) | (s[:, 8] > 0.5)]             # twigs inside the foliage: no cards
    p0, p1, rad, dead = s[:, 0:3], s[:, 3:6], s[:, 6], s[:, 8] > 0.5
    seglen = np.linalg.norm(p1 - p0, axis=1)
    h = np.clip(3.5 * rad, 0.08, 0.12)                 # card height across the branch
    step = h * atlas.aspect * np.where(rad > 0.012, 0.85, 1.25)   # thin twigs: dashed
    cnt = np.maximum(1, np.ceil(seglen / step)).astype(int)
    si = np.repeat(np.arange(len(s)), cnt)
    k = np.arange(len(si)) - np.repeat(np.cumsum(cnt) - cnt, cnt)
    tt = (k + 0.5) / cnt[si]
    T = unit(p1 - p0)[si]
    C = p0[si] + (p1 - p0)[si] * tt[:, None]
    hh = h[si] * rng.uniform(0.9, 1.1, len(si))
    U = T * (hh * atlas.aspect)[:, None]               # glyph's horizontal runs along the wood
    V = facing_perp(T, C, rng, 0.6) * hh[:, None]      # turned round the branch
    thick = rad[si] > 0.012
    pick_thick = atlas.ids(WOOD_THICK, rng.integers(0, len(WOOD_THICK), len(si)))
    pick_thin = atlas.ids(WOOD_THIN, rng.integers(0, len(WOOD_THIN), len(si)))
    pick_dead = atlas.ids(DEAD_CH, rng.integers(0, len(DEAD_CH), len(si)))
    ch = np.where(dead[si], pick_dead, np.where(thick, pick_thick, pick_thin))
    warm = smoothstep(0.55, 0.9, C[:, 1] / TREE_H)[:, None]
    alb = np.array([0.50, 0.34, 0.22]) * (1 - warm) + np.array([0.75, 0.42, 0.22]) * warm
    alb = np.where(dead[si][:, None], np.array([0.48, 0.45, 0.42]), alb)
    alb = alb * (1 + 0.12 * rng.normal(size=(len(si), 1)))
    ts, tk = light.sun(C), light.sky(C)
    col, _ = light_cards(C, U, V, alb, ts, tk, 0.12, 10, 0.0)
    cards.add(C, U, V, ch, col, rng.uniform(0.82, 0.95, len(si)))


def bark_noise(grid, a, b):
    G = grid.shape[0]
    return map_coordinates(grid, [np.mod(a, G), np.mod(b, G)], order=3, mode="grid-wrap")


def worley(a, b, jit, cw, ch):
    P = jit.shape[0]
    ia, ib = np.floor(a / cw).astype(np.int64), np.floor(b / ch).astype(np.int64)
    f1 = np.full(a.shape, 9.0)
    f2 = np.full(a.shape, 9.0)
    for da in (-1, 0, 1):
        for db in (-1, 0, 1):
            ca, cb = ia + da, ib + db
            j = jit[np.mod(ca, P), np.mod(cb, P)]
            d = np.hypot((a - (ca + j[:, 0]) * cw) / cw, (b - (cb + j[:, 1]) * ch) / ch)
            f2 = np.where(d < f1, f1, np.minimum(f2, d))
            f1 = np.minimum(f1, d)
    return f1, f2


def trunk_cards(tree, light, atlas, rng, cards):
    spacing = 0.07
    P, N, A, TH = [], [], [], []
    for y in np.arange(-0.05, TREE_H, spacing):
        r = float(tree.trunk_radius(y))
        cx, cz = tree.trunk_center(y)
        cx2, cz2 = tree.trunk_center(y + 0.05)
        n = max(4, int(math.ceil(2 * math.pi * r / spacing)))
        th = (np.arange(n) + rng.random()) / n * 2 * math.pi + rng.normal(0, 0.15 / n * 6, n)
        nrm = np.stack([np.sin(th), np.zeros(n), np.cos(th)], 1)
        pts = np.array([cx, y, cz]) + r * nrm + UP * rng.uniform(-0.4, 0.4, n)[:, None] * spacing
        view = (unit(CAM - pts) * nrm).sum(1)
        keep = view > -0.1                                  # only the side we can see
        P.append(pts[keep])
        N.append(nrm[keep])
        A.append(np.tile(unit([(cx2 - cx) / 0.05, 1.0, (cz2 - cz) / 0.05]), (keep.sum(), 1)))
        TH.append(th[keep])
    P, N, A, th = np.vstack(P), np.vstack(N), np.vstack(A), np.concatenate(TH)
    n = len(P)
    tang = np.stack([np.cos(th), np.zeros(n), -np.sin(th)], 1)
    phi = rng.normal(0, 0.18, n)[:, None]
    U = unit(tang * np.cos(phi) + A * np.sin(phi) + N * rng.normal(0, 0.25, (n, 1)))
    V = unit(-tang * np.sin(phi) + A * np.cos(phi) + N * rng.normal(0, 0.25, (n, 1)))
    hh = rng.uniform(0.11, 0.13, n)[:, None]
    U, V = U * hh * atlas.aspect, V * hh
    C = P + N * rng.uniform(0.0, 0.012, (n, 1))

    # bark pattern, the same plates-and-fissures model as the polygon version
    grid = gaussian_filter(rng.random((256, 256)), 0.6)
    grid = (grid - grid.min()) / (grid.max() - grid.min())
    y = P[:, 1]
    rr = tree.trunk_radius(y)
    arc = (th + tree.ph[3]) * rr
    wa = arc + 0.018 * (bark_noise(grid, arc * 20, y * 5) - 0.5)
    wb = y + 0.06 * (bark_noise(grid, arc * 20 + 33, y * 5) - 0.5)
    f1, f2 = worley(wa, wb, rng.random((512, 512, 2)), 0.075, 0.24)
    edge = f2 - f1
    fiss = smoothstep(0.12 + 0.14 * bark_noise(grid, arc * 12 + 7, y * 2.5), 0.02, edge)
    raised = smoothstep(0.05, 0.6, edge)
    mott = bark_noise(grid, arc * 45 + 90, y * 18)
    flake = smoothstep(0.56, 0.74, bark_noise(grid, arc * 14 + 20, y * 40))
    m = smoothstep(0.4, 0.62, y / TREE_H + 0.12 * (bark_noise(grid, arc * 5, y * 1.5) - 0.5))
    upper = rng.random(n) < m

    pick = lambda cs: atlas.ids(cs, rng.integers(0, len(cs), n))
    ch = np.where(fiss > 0.45, pick(BARK_FISS), np.where(raised > 0.55, pick(BARK_PLATE), pick(BARK_MID)))
    ch = np.where(upper, pick(BARK_UP), ch)
    low = np.array([0.58, 0.48, 0.40]) * ((0.75 + 0.45 * mott) * (0.8 + 0.3 * raised))[:, None]
    low = np.where((fiss > 0.45)[:, None], np.array([0.24, 0.14, 0.10]), low)
    up = np.array([0.95, 0.50, 0.27]) * (0.85 + 0.3 * flake)[:, None]
    alb = np.where(upper[:, None], up, low) * (0.7 + 0.3 * smoothstep(0.0, 0.8, y))[:, None]
    ts, tk = light.sun(C + N * 0.05), light.sky(C)
    col, _ = light_cards(C, U, V, alb, ts, tk, 0.08, 12, 0.0, wrap=0.1)
    cards.add(C, U, V, ch, col, rng.uniform(0.95, 1.0, n))


# ---- surroundings -----------------------------------------------------------
def fbm2(h, w, rng, base=3, octaves=5, aspect=1.0):
    out = np.zeros((h, w), np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        gw = base * 2 ** o + 1
        gh = max(2, int(gw * h / w / aspect) + 1)
        small = rng.random((gh, gw)).astype(np.float32)
        out += amp * np.asarray(Image.fromarray(small).resize((w, h), Image.BICUBIC))
        tot += amp
        amp *= 0.5
    return out / tot


def noise1d(n, rng, knots, smooth):
    v = np.interp(np.linspace(0, knots, n), np.arange(knots + 1), rng.random(knots + 1))
    return gaussian_filter1d(v, smooth)


def treeline(rng, base, hill_amp, hmin, hmax, count):
    xs = np.arange(W)
    h = base + hill_amp * noise1d(W, rng, 8, 20)
    canopy = hmin * 0.6 * noise1d(W, rng, 60, 3)
    for _ in range(count):
        c = rng.uniform(-30, W + 30)
        hh = rng.uniform(hmin, hmax)
        if rng.random() < 0.65:
            prof = hh * (1 - np.abs(xs - c) / (hh * rng.uniform(0.2, 0.42)))
        else:
            w = hh * rng.uniform(0.5, 0.9)
            prof = hh * 0.8 * np.sqrt(np.clip(1 - ((xs - c) / w) ** 2, 0, 1))
        canopy = np.maximum(canopy, prof)
    return h + canopy


def screen_to_plane(sx, sy, z):
    """Output-pixel position -> world point on the plane at depth z."""
    d = DIST - z
    return np.stack([(sx - CX) * d / FOCAL, EYE - (sy - HORIZON) * d / FOCAL, np.full_like(sx, z)], 1), d


def facing_cards(C, size_world, rng, yaw_sd, roll_sd, aspect):
    """Cards that roughly face the camera, turned a little in 3D."""
    n = len(C)
    yaw = rng.normal(0, yaw_sd, n)
    roll = rng.normal(0, roll_sd, n)
    U = np.stack([np.cos(yaw) * np.cos(roll), np.sin(roll), np.sin(yaw)], 1)
    V = np.stack([-np.sin(roll) * np.cos(yaw), np.cos(roll), -np.sin(roll) * np.sin(yaw)], 1)
    return U * (size_world * aspect)[:, None], V * size_world[:, None]


def sky_cards(atlas, rng, cards, skyline):
    """Evening sky seen away from the sun: deep blue overhead, the pink band
    just above the horizon and the blue-grey shadow of the earth under it.
    Brightness picks the character from a density ramp."""
    cl = fbm2(H, W, rng, base=3, octaves=6, aspect=0.35)
    gx, gy = np.meshgrid(np.arange(3, W, 7.2), np.arange(4, HORIZON - 3, 10.5))
    gx = gx + (np.arange(gx.shape[0]) % 2)[:, None] * 3.6      # offset alternate rows
    sx = gx.ravel() + rng.uniform(-1.4, 1.4, gx.size)
    sy = gy.ravel() + rng.uniform(-1.4, 1.4, gx.size)
    keep = sy < skyline[np.clip(sx.astype(int), 0, W - 1)] - 2      # not behind the forest
    sx, sy = sx[keep], sy[keep]
    n = sx.size
    t = sy / HORIZON
    cloud = smoothstep(0.55, 0.75, cl[sy.astype(int), np.clip(sx.astype(int), 0, W - 1)]) \
        * np.clip(sy / (0.1 * H), 0, 1) * np.clip((HORIZON - sy) / (0.25 * HORIZON), 0, 1)
    ts_ = [0.0, 0.45, 0.72, 0.84, 0.93, 1.0]
    cs_ = [(22, 32, 78), (46, 68, 140), (118, 108, 170), (230, 152, 160), (152, 132, 168), (96, 104, 146)]
    col = np.stack([np.interp(t, ts_, [c[k] for c in cs_]) for k in range(3)], 1)
    b = 0.1 + np.interp(t, [0, 0.5, 0.8, 0.88, 1], [0.0, 0.2, 0.62, 0.72, 0.5])
    b = np.clip(b + 0.55 * cloud + rng.normal(0, 0.06, n), 0, 1)
    cloud_col = np.array([150, 136, 186]) * (1 - np.clip(1.3 * t, 0, 1)[:, None]) \
        + np.array([255, 196, 160]) * np.clip(1.3 * t, 0, 1)[:, None]
    col = col * (1 - cloud[:, None]) + cloud_col * cloud[:, None]
    ch = atlas.ids(SKY_RAMP, np.round(b * (len(SKY_RAMP) - 1)).astype(int))
    C, d = screen_to_plane(sx, sy, -700.0)
    U, V = facing_cards(C, rng.uniform(12, 14.5, n) * d / FOCAL, rng, 0.3, 0.08, atlas.aspect)
    cards.add(C, U, V, ch, col * 0.85, np.full(n, 0.6))

    # the first stars in the darkest part of the sky
    m = 140
    sx, sy = rng.uniform(0, W, m), HORIZON * 0.42 * rng.random(m) ** 1.5
    C, d = screen_to_plane(sx, sy, -750.0)
    U, V = facing_cards(C, rng.uniform(9, 13, m) * d / FOCAL, rng, 0.4, 0.5, atlas.aspect)
    cards.add(C, U, V, atlas.ids("*+.", rng.integers(0, 3, m)),
              np.tile([235, 235, 255], (m, 1)) * rng.uniform(0.6, 1.0, (m, 1)), np.full(m, 1.0))


FOREST_LAYERS = ((-260.0, 13, 44, 8, 28, 420, (96, 92, 132), FOREST_FAR),
                 (-140.0, 3, 16, 10, 39, 330, (58, 72, 78), FOREST_NEAR))


def forest_tops(rng):
    return [HORIZON - treeline(rng, base, amp, hmin, hmax, cnt)
            for _, base, amp, hmin, hmax, cnt, _, _ in FOREST_LAYERS]


def forest_cards(atlas, rng, cards, tops):
    for (z, _, _, _, _, _, tone, cs), top in zip(FOREST_LAYERS, tops):
        gx, gy = np.meshgrid(np.arange(2, W, 6.0), np.arange(top.min() - 4, HORIZON + 3, 7.5))
        sx = gx.ravel() + rng.uniform(-1.2, 1.2, gx.size)
        sy = gy.ravel() + rng.uniform(-1.2, 1.2, gx.size)
        keep = (sy > top[np.clip(sx.astype(int), 0, W - 1)]) & (sx >= 0) & (sx < W)
        sx, sy = sx[keep], sy[keep]
        n = len(sx)
        C, d = screen_to_plane(sx, sy, z)
        U, V = facing_cards(C, rng.uniform(10, 13, n) * d / FOCAL, rng, 0.35, 0.12, atlas.aspect)
        col = np.array(tone) * rng.uniform(0.82, 1.15, (n, 1))
        cards.add(C, U, V, atlas.ids(cs, rng.integers(0, len(cs), n)), col, np.full(n, 0.92))


def shadow_mask(tree, rng):
    """The tree's shadow on the ground (output-pixel grid), cast along the sun."""
    P = (tree.n_p0 + tree.n_p1) / 2
    P = P[rng.random(len(P)) < 0.5]
    ys = np.linspace(0, TREE_H, 600)
    cx, cz = tree.trunk_center(ys)
    trunk = np.concatenate([np.stack([cx + o * tree.trunk_radius(ys), ys, cz], 1)
                            for o in np.linspace(-1, 1, 9)])
    acc = np.zeros((H, W), np.float32)
    for pts, wgt in ((P, 1.0), (trunk, 3.0)):
        g = pts - SUN[None] * (pts[:, 1:2] / SUN[1])
        d = DIST - g[:, 2]
        sx = (CX + FOCAL * g[:, 0] / d).astype(int)
        sy = (HORIZON + FOCAL * EYE / d).astype(int)
        ok = (sx >= 0) & (sx < W) & (sy >= 0) & (sy < H)
        np.add.at(acc, (sy[ok], sx[ok]), wgt)
    acc = gaussian_filter(acc, 9.0)
    return 1 - np.exp(-acc * 2.2)


def ground_cards(atlas, rng, shadow, cards):
    haze_col = np.array([120, 112, 140])

    def at_screen(n, bias):
        sx = rng.uniform(-12, W + 12, n)
        sy = HORIZON + 1.5 + (H + 25 - HORIZON - 1.5) * rng.random(n) ** bias
        d = FOCAL * EYE / (sy - HORIZON)
        return sx, sy, d, (sx - CX) * d / FOCAL, DIST - d

    def finish(C, U, V, ch, alb, sx, sy, d, spec, trans, alpha):
        sh = shadow[np.clip(sy.astype(int), 0, H - 1), np.clip(sx.astype(int), 0, W - 1)]
        col, _ = light_cards(C, U, V, alb, 1 - 0.75 * sh, np.full(len(C), 0.9), spec, 14, trans)
        hz = (np.clip(d / 110, 0, 1) ** 0.65)[:, None]
        cards.add(C, U, V, ch, col * (1 - hz) + haze_col * hz, alpha)

    # flat soil marks lying on the ground (heavily foreshortened)
    n = 3500
    sx, sy, d, gx, gz = at_screen(n, 1.0)
    frac = np.clip((sy - HORIZON) / (H - HORIZON), 0, 1)
    size = rng.uniform(14, 22, n) * (0.6 + 0.4 * frac) * d / FOCAL * 1.4
    yaw = rng.uniform(0, 2 * np.pi, n)
    U = np.stack([np.cos(yaw), np.zeros(n), np.sin(yaw)], 1) * (size * atlas.aspect)[:, None]
    V = np.stack([-np.sin(yaw), np.zeros(n), np.cos(yaw)], 1) * size[:, None]
    C = np.stack([gx, np.full(n, 0.002), gz], 1)
    alb = np.array([0.22, 0.26, 0.11]) * rng.uniform(0.7, 1.3, (n, 1))
    finish(C, U, V, atlas.ids(SOIL_CH, rng.integers(0, len(SOIL_CH), n)), alb, sx, sy, d, 0.1, 0.0,
           np.full(n, 0.7))

    # standing grass blades, about the same on-screen size, a little smaller far away
    n = 12000
    sx, sy, d, gx, gz = at_screen(n, 1.0)
    frac = np.clip((sy - HORIZON) / (H - HORIZON), 0, 1)
    hgt = rng.uniform(14, 22, n) * (0.55 + 0.45 * frac) * d / FOCAL
    # extra blades around the trunk base
    m = 250
    bx, bz = rng.normal(0, 1.1, m), rng.normal(0, 0.9, m)
    bsx, bsy, bd = project(np.stack([bx, np.zeros(m), bz], 1))
    sx, sy, d = np.concatenate([sx, bsx / SS]), np.concatenate([sy, bsy / SS]), np.concatenate([d, bd])
    gx, gz = np.concatenate([gx, bx]), np.concatenate([gz, bz])
    hgt = np.concatenate([hgt, rng.uniform(0.1, 0.15, m)])
    n += m
    tilt, tdir, yaw = rng.normal(0, 0.3, n), rng.uniform(0, 2 * np.pi, n), rng.uniform(0, 2 * np.pi, n)
    Vd = np.stack([np.sin(tilt) * np.cos(tdir), np.cos(tilt), np.sin(tilt) * np.sin(tdir)], 1)
    C = np.stack([gx, np.zeros(n), gz], 1) + Vd * (hgt / 2)[:, None]
    Ud = facing_perp(Vd, C, rng, 0.7)
    U, V = Ud * (hgt * atlas.aspect)[:, None], Vd * hgt[:, None]
    tone = rng.random((n, 1))
    alb = np.array([0.22, 0.40, 0.12]) * (1 - tone) + np.array([0.38, 0.52, 0.17]) * tone
    alb = np.where(rng.random((n, 1)) < 0.15, np.array([0.55, 0.50, 0.25]), alb)
    ch = atlas.ids(GRASS_CH, rng.choice(len(GRASS_CH), n, p=np.array(GRASS_P) / sum(GRASS_P)))
    finish(C, U, V, ch, alb, sx, sy, d, 0.2, 0.3, rng.uniform(0.78, 0.95, n))


# ---- rasterizing the cards --------------------------------------------------
def rasterize(cards, atlas):
    C, U, V, ch, col, alpha = cards.arrays()
    sx, sy, d = project(C)
    ux, uy, _ = project(C + U / 2)
    vx, vy, _ = project(C + V / 2)
    sux, suy, svx, svy = ux - sx, uy - sy, vx - sx, vy - sy
    det = sux * svy - svx * suy
    ex, ey = np.abs(sux) + np.abs(svx), np.abs(suy) + np.abs(svy)
    x0 = np.floor(sx - ex).astype(int) - 1
    y0 = np.floor(sy - ey).astype(int) - 1
    bw = np.ceil(2 * ex).astype(int) + 3
    bh = np.ceil(2 * ey).astype(int) + 3
    SW, SH = W * SS, H * SS
    ok = ((np.abs(det) > 0.6) & (d > 0.5) & (bw < 400) & (bh < 400)
          & (x0 + bw > 0) & (x0 < SW) & (y0 + bh > 0) & (y0 < SH))
    safe = np.where(np.abs(det) > 1e-9, det, 1.0)
    m00, m01, m10, m11 = svy / safe, -svx / safe, -suy / safe, sux / safe
    ox, oy = x0 - sx, y0 - sy
    TW, TH = atlas.TW, atlas.TH
    A, B = m00 * TW / 2, m01 * TW / 2
    Cc = (m00 * ox + m01 * oy + 1) * TW / 2
    D, E = -m10 * TH / 2, -m11 * TH / 2
    F = (1 - (m10 * ox + m11 * oy)) * TH / 2
    lv = np.clip(np.round(alpha * (Atlas.LEVELS - 1)), 1, Atlas.LEVELS - 1).astype(int)
    colors = np.clip(col, 0, 255).astype(np.uint8)

    order = np.argsort(-d, kind="stable")
    order = order[ok[order]]                     # far to near
    canvas = Image.new("RGB", (SW, SH), BG)
    cells = atlas.cells
    affine, bilinear = Image.Transform.AFFINE, Image.Resampling.BILINEAR
    for i in order.tolist():
        w, h = int(bw[i]), int(bh[i])
        mask = cells[ch[i]][lv[i]].transform((w, h), affine,
                                             (A[i], B[i], Cc[i], D[i], E[i], F[i]), bilinear)
        canvas.paste(tuple(colors[i].tolist()), (int(x0[i]), int(y0[i]), int(x0[i]) + w, int(y0[i]) + h), mask)
    return canvas, len(order)


def render(seed, out_path):
    rng = np.random.default_rng(seed + 7919)
    tree = Pine(seed)
    light = Light((tree.n_p0 + tree.n_p1) / 2)
    charset = sorted(set(NEEDLE_CH + TIP_CH + WOOD_THICK + WOOD_THIN + DEAD_CH + BARK_PLATE + BARK_MID
                         + BARK_FISS + BARK_UP + GRASS_CH + SOIL_CH + FOREST_FAR + FOREST_NEAR + SKY_RAMP))
    atlas = Atlas(charset)
    cards = Cards()
    tops = forest_tops(rng)
    sky_cards(atlas, rng, cards, np.minimum(*tops))
    forest_cards(atlas, rng, cards, tops)
    ground_cards(atlas, rng, shadow_mask(tree, rng), cards)
    trunk_cards(tree, light, atlas, rng, cards)
    wood_cards(tree, light, atlas, rng, cards)
    needle_cards(tree, light, atlas, rng, cards)
    canvas, drawn = rasterize(cards, atlas)
    canvas.resize((W, H), Image.Resampling.LANCZOS).save(out_path)   # supersampling only
    return drawn


if __name__ == "__main__":
    seed = int(sys.argv[1]) if len(sys.argv) > 1 else 23
    out = sys.argv[2] if len(sys.argv) > 2 else "pine_ascii.png"
    n = render(seed, out)
    print(f"seed {seed}: {n} ASCII cards -> {out}")
