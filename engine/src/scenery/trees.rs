//! Trees: two growth models, six species. Port of `scenery/trees.py`.
//!
//! Conifers (pine, spruce): whorl model. A leader leaves a whorl of primaries
//! each year; primaries follow a crown envelope, sag and turn up; side shoots
//! branch in 3D, inner ones die; needles are one sprite per spray.
//!
//! Broadleaf (oak, birch, maple, dead snag): space colonization inside a
//! crown envelope, pipe-model radii, root flare, leaves on the twigs.

use super::asset::{dir, polyline, unit, Asset, RngExt, UP};
use super::colonize::{colonize, envelope_points, pipe_radii, smooth};
use super::perlin::Perlin;
use super::style::{Bark, Mat};
use crate::math::Vec3;
use crate::rng::Pcg32;
use std::f32::consts::TAU;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TreeKind {
    Pine,
    Spruce,
    Oak,
    Birch,
    Maple,
    Dead,
}

impl TreeKind {
    pub const ALL: [TreeKind; 6] = [TreeKind::Pine, TreeKind::Spruce, TreeKind::Oak, TreeKind::Birch, TreeKind::Maple, TreeKind::Dead];

    pub fn name(self) -> &'static str {
        ["pine", "spruce", "oak", "birch", "maple", "dead"][self as usize]
    }
}

pub fn make_tree(seed: u32, kind: TreeKind) -> Asset {
    match kind {
        TreeKind::Pine | TreeKind::Spruce => Conifer::grow(seed, kind),
        _ => broadleaf(seed, kind),
    }
}

// ---- conifers -------------------------------------------------------------------

struct ConiferParams {
    h: (f32, f32),
    base: (f32, f32),
    gap: (f32, f32),
    per: (u32, u32),
    lmax: f32,
    cone: bool,
    e0: f32,
    e1: f32,
    sag0: f32,
    sag1: f32,
    up: (f32, f32),
    side: (f32, f32),
    side_lo: f32,
    dead: f32,
    fol1: (f32, f32),
    fol2: (f32, f32),
    dens: f32,
    needle: Mat,
    nsize: (f32, f32),
    bark: Bark,
    r0: f32,
    sway: f32,
    hang: f32,
}

fn conifer_params(kind: TreeKind) -> ConiferParams {
    if kind == TreeKind::Pine {
        ConiferParams {
            h: (9.0, 12.0), base: (0.25, 0.32), gap: (0.42, 0.75), per: (4, 8), lmax: 2.75, cone: false, e0: -0.12, e1: 0.8,
            sag0: 0.6, sag1: 0.12, up: (0.3, 0.75), side: (0.1, 0.17), side_lo: 0.25, dead: 0.55, fol1: (0.45, 0.7),
            fol2: (0.3, 0.55), dens: 24.0, needle: Mat::NeedlePine, nsize: (0.14, 0.2), bark: Bark::Pine, r0: 0.21,
            sway: 0.28, hang: 0.0,
        }
    } else {
        ConiferParams {
            h: (10.0, 15.0), base: (0.05, 0.1), gap: (0.28, 0.42), per: (5, 8), lmax: 2.6, cone: true, e0: -0.38, e1: 0.3,
            sag0: 0.45, sag1: 0.15, up: (0.35, 0.65), side: (0.1, 0.16), side_lo: 0.08, dead: 0.1, fol1: (9.0, 9.0),
            fol2: (9.0, 9.0), dens: 15.0, needle: Mat::NeedleSpruce, nsize: (0.12, 0.17), bark: Bark::Spruce, r0: 0.2,
            sway: 0.08, hang: 0.6,
        }
    }
}

struct Conifer {
    p: ConiferParams,
    rng: Pcg32,
    h: f32,
    k: f32,
    ph: [f32; 3],
    crown_base: f32,
    a: Asset,
    tips: Vec<(Vec3, Vec3)>,
}

impl Conifer {
    fn grow(seed: u32, kind: TreeKind) -> Asset {
        let p = conifer_params(kind);
        let mut rng = Pcg32::new(seed as u64, 0xc0f1);
        let h = rng.uniform(p.h.0, p.h.1);
        let ph = [rng.uniform(0.0, TAU), rng.uniform(0.0, TAU), rng.uniform(0.0, TAU)];
        let crown_base = rng.uniform(p.base.0, p.base.1) * h;
        let mut c = Conifer { p, rng, h, k: h / 10.0, ph, crown_base, a: Asset::new(kind.name()), tips: Vec::new() };
        c.grow_all();
        let tips = std::mem::take(&mut c.tips);
        for (q, d) in tips {
            if c.rng.chance(0.4) {
                c.a.sprite(q + d * 0.06, d + UP * 0.3, 0.13, Mat::ShootTip, None);
            }
        }
        c.a
    }

    fn center(&self, y: f32) -> (f32, f32) {
        let t = y / self.h;
        let s = self.p.sway;
        (
            t * (s * (1.8 * t + self.ph[0]).sin() + s * 0.25 * (5.5 * t + self.ph[1]).sin()),
            t * (s * 0.7 * (1.4 * t + self.ph[2]).sin()),
        )
    }

    fn radius(&self, y: f32) -> f32 {
        let y = y.max(0.0);
        let t = (y / self.h).min(1.0);
        (0.02 + self.p.r0 * (1.0 - t).powf(1.15)) * self.k + 0.11 * self.k * (-y / 0.35).exp()
    }

    fn envelope(&self, t: f32) -> f32 {
        let l = self.p.lmax * self.k;
        if self.p.cone {
            0.25 + l * (1.0 - t).powf(1.05)
        } else {
            0.3 + l * (1.0 - t).powf(0.85) * (0.8 + 0.2 * (t / 0.2).min(1.0))
        }
    }

    fn grow_all(&mut self) {
        // Trunk.
        let mut y = -0.05;
        let mut prev: Option<Vec3> = None;
        while y < self.h + 0.05 {
            let (cx, cz) = self.center(y);
            let q = Vec3::new(cx, y, cz);
            if let Some(pq) = prev {
                let r = self.radius(pq.y + 0.15);
                self.a.wood(pq, q, r, 0, self.p.bark);
            }
            prev = Some(q);
            y += 0.3;
        }
        let mut whorls = Vec::new();
        let mut y = self.crown_base;
        while y < self.h - 0.45 {
            whorls.push(y);
            y += self.rng.uniform(self.p.gap.0, self.p.gap.1) * (0.8 + 0.2 * self.k);
        }
        let span = self.h - self.crown_base;
        for yw in whorls {
            let t = (yw - self.crown_base) / span;
            let n = self.rng.int(self.p.per.0, self.p.per.1);
            let rot = self.rng.uniform(0.0, TAU);
            for j in 0..n {
                if self.rng.chance(if t < 0.12 { 0.3 } else { 0.1 }) {
                    continue;
                }
                let az = rot + TAU * j as f32 / n as f32 + self.rng.gauss(0.3);
                let yb = yw + self.rng.uniform(-0.05, 0.05);
                let (cx, cz) = self.center(yb);
                let rad = self.radius(yb);
                let base = Vec3::new(cx + 0.7 * rad * az.sin(), yb, cz + 0.7 * rad * az.cos());
                let len = self.envelope(t) * self.rng.uniform(0.6, 1.18);
                self.primary(base, az, len, t);
            }
        }
        let top: Vec<Vec3> = (0..7)
            .map(|i| {
                let y = self.h - 0.65 + 0.7 * i as f32 / 6.0;
                let (cx, cz) = self.center(y);
                Vec3::new(cx, y, cz)
            })
            .collect();
        self.needles(&top, 0.7);
        if self.p.dead > 0.3 {
            // Self-pruned stubs on the bare trunk.
            for _ in 0..self.rng.int(3, 7) {
                let yb = self.rng.uniform(1.2, self.crown_base - 0.1);
                let (az, el, len) = (self.rng.uniform(0.0, TAU), self.rng.uniform(-0.3, 0.2), self.rng.uniform(0.1, 0.4));
                let (cx, cz) = self.center(yb);
                let rad = self.radius(yb);
                let mut q = vec![Vec3::new(cx, yb, cz) + Vec3::new(az.sin(), 0.0, az.cos()) * (0.8 * rad)];
                for s in [1.0 / 3.0, 2.0 / 3.0, 1.0] {
                    let last = q[q.len() - 1];
                    q.push(last + dir(az, el - 0.5 * s) * (len / 3.0));
                }
                let r = self.rng.uniform(0.015, 0.026);
                self.a.wood_chain(&q, |_, _| r, 1, Bark::Dead);
            }
        }
    }

    fn primary(&mut self, base: Vec3, az: f32, len: f32, t: f32) {
        let e0 = self.p.e0 + (self.p.e1 - self.p.e0) * t + self.rng.gauss(0.1);
        let sag = (self.p.sag0 * (1.0 - t) + self.p.sag1) * self.rng.uniform(0.7, 1.3);
        let upturn = self.rng.uniform(self.p.up.0, self.p.up.1);
        let n = ((len / 0.12) as usize).max(5);
        let mut pts = vec![base];
        let mut ang = az;
        for i in 0..n {
            let s = (i as f32 + 0.5) / n as f32;
            let e = e0 - sag * s + upturn * s * s * s;
            ang += self.rng.gauss(0.05);
            let last = pts[pts.len() - 1];
            pts.push(last + dir(ang, e) * (len / n as f32));
        }
        pts.iter_mut().for_each(|q| q.y = q.y.max(0.15)); // low branches rest on the ground
        let r0 = 0.022 + 0.022 * len / 2.5;
        self.a.wood_chain(&pts, |i, n| r0 * (1.0 - 0.7 * i as f32 / (n - 1).max(1) as f32), 1, self.p.bark);
        self.children(&pts, len, 1);
        let fol = self.rng.uniform(self.p.fol1.0, self.p.fol1.1);
        self.needles(&pts, fol);
    }

    fn shoot(&mut self, q: Vec3, d0: Vec3, len: f32, level: u8, dead: bool, hang: bool) {
        let n = ((len / 0.1) as usize + 1).max(2);
        let mut pts = vec![q];
        let mut d = d0;
        let g = if hang { -0.25 } else { 0.0 };
        for i in 0..n {
            let s = i as f32 / n as f32;
            let lift = -0.07 * (1.0 - s) + if hang { -0.05 } else { 0.12 } * s * s + g * 0.3;
            d = unit(d + Vec3::new(0.0, lift, 0.0) + self.rng.gauss3(0.06));
            let last = pts[pts.len() - 1];
            pts.push(last + d * (len / n as f32));
        }
        pts.iter_mut().for_each(|p| p.y = p.y.max(0.08));
        let r = 0.005 + 0.01 * len.min(1.0);
        self.a.wood_chain(&pts, |_, _| r, level, if dead { Bark::Dead } else { self.p.bark });
        if dead {
            return;
        }
        self.children(&pts, len, level);
        let fol = if level == 2 { len.min(self.rng.uniform(self.p.fol2.0, self.p.fol2.1)) } else { len };
        self.needles(&pts, fol);
    }

    fn children(&mut self, pts: &[Vec3], len: f32, level: u8) {
        let (spacing, s_lo, s_hi) = match level {
            1 => (self.p.side, self.p.side_lo, 0.95),
            2 if len >= 0.25 => ((0.08, 0.14), 0.12, 0.9),
            _ => return,
        };
        let (segs, sl, cum) = polyline(pts);
        let mut pos = s_lo * len + self.rng.uniform(0.0, spacing.1);
        while pos < s_hi * len {
            let s = pos / len;
            let i = cum.partition_point(|&c| c <= pos).saturating_sub(1).min(segs.len() - 1);
            let q = pts[i] + segs[i] * ((pos - cum[i]) / sl[i]);
            let t = segs[i] * (1.0 / sl[i]);
            let sv0 = t.cross(UP).try_normalize().unwrap_or(Vec3::X);
            for sg in [-1.0f32, 1.0] {
                if self.rng.chance(if level == 1 { 0.1 } else { 0.3 }) {
                    continue;
                }
                if level == 1 && self.p.hang > 0.0 && q.y > 1.2 && self.rng.chance(self.p.hang) {
                    // Spruce curtains: secondary shoots hanging down.
                    let dc = unit(t * 0.25 + sv0 * (sg * 0.35) + Vec3::new(0.0, -0.9, 0.0) + self.rng.gauss3(0.15));
                    let l = len * self.rng.uniform(0.12, 0.28);
                    self.shoot(q, dc, l, 2, false, true);
                    continue;
                }
                let roll = self.rng.gauss(0.55);
                let sv = sv0 * roll.cos() + t.cross(sv0) * roll.sin();
                let al = self.rng.uniform(0.55, 1.05);
                let lift = self.rng.uniform(-0.1, 0.35);
                let dc = unit(t * al.cos() + sv * (sg * al.sin()) + UP * lift);
                let (lc, dead) = if level == 1 {
                    let lc = len * 0.38 * (1.0 - s).powf(0.6) * (0.5 + 0.8 * s) * self.rng.uniform(0.6, 1.15);
                    (lc, s < 0.42 && self.rng.chance(self.p.dead))
                } else {
                    (len * 0.55 * (1.0 - s).powf(0.7) * self.rng.uniform(0.6, 1.1), false)
                };
                if lc > 0.08 {
                    self.shoot(q, dc, lc, level + 1, dead, false);
                }
            }
            pos += self.rng.uniform(spacing.0, spacing.1);
        }
    }

    fn needles(&mut self, pts: &[Vec3], fol: f32) {
        let (segs, sl, cum) = polyline(pts);
        let total = cum[cum.len() - 1];
        let fol = fol.min(total);
        let cnt = (self.p.dens * fol + self.rng.next_f32()) as usize;
        let last = segs.len() - 1;
        self.tips.push((pts[pts.len() - 1], segs[last] * (1.0 / sl[last])));
        for _ in 0..cnt {
            let x = self.rng.next_f32().powf(1.5);
            let u = total - fol * x;
            let i = cum.partition_point(|&c| c <= u).saturating_sub(1).min(last);
            let base = pts[i] + segs[i] * ((u - cum[i]) / sl[i]);
            let t = segs[i] * (1.0 / sl[i]);
            let r = if t.y.abs() > 0.95 { Vec3::X } else { UP };
            let b1 = unit(t.cross(r));
            let b2 = t.cross(b1);
            let psi = self.rng.uniform(0.0, TAU);
            let al = self.rng.uniform(0.55, 1.05) * (0.45 + 0.55 * (x / 0.15).min(1.0));
            let mut dv = t * al.cos() + (b1 * psi.cos() + b2 * psi.sin()) * al.sin();
            dv.y += 0.22;
            let dv = unit(dv);
            let h = self.rng.uniform(self.p.nsize.0, self.p.nsize.1);
            self.a.sprite(base + dv * (h * 0.45), dv, h, self.p.needle, None);
        }
    }
}

// ---- broadleaf ----------------------------------------------------------------

struct BroadParams {
    h: (f32, f32),
    trunk: (f32, f32),
    crown: [f32; 3],
    blobs: (u32, u32),
    att: usize,
    d: f32,
    trop: f32,
    leader: f32,
    leaf: Option<Mat>,
    lsize: (f32, f32),
    per: usize,
    droop: f32,
    bark: Bark,
    r_trunk: (f32, f32),
    lean: f32,
    gnarl: f32,
}

fn broad_params(kind: TreeKind) -> BroadParams {
    match kind {
        TreeKind::Oak => BroadParams {
            h: (10.0, 13.0), trunk: (0.22, 0.3), crown: [0.44, 0.38, 0.44], blobs: (5, 9), att: 4200, d: 0.22, trop: 0.02,
            leader: 0.0, leaf: Some(Mat::LeafOak), lsize: (0.2, 0.28), per: 3, droop: 0.15, bark: Bark::Oak,
            r_trunk: (0.32, 0.45), lean: 0.12, gnarl: 0.25,
        },
        TreeKind::Birch => BroadParams {
            h: (12.0, 16.0), trunk: (0.22, 0.32), crown: [0.25, 0.4, 0.25], blobs: (3, 5), att: 5200, d: 0.17, trop: -0.07,
            leader: 0.8, leaf: Some(Mat::LeafBirch), lsize: (0.16, 0.23), per: 6, droop: 0.7, bark: Bark::Birch,
            r_trunk: (0.14, 0.2), lean: 0.08, gnarl: 0.08,
        },
        TreeKind::Maple => BroadParams {
            h: (10.0, 13.0), trunk: (0.25, 0.32), crown: [0.38, 0.35, 0.38], blobs: (4, 7), att: 3400, d: 0.2, trop: 0.03,
            leader: 0.35, leaf: Some(Mat::LeafMaple), lsize: (0.18, 0.24), per: 3, droop: 0.25, bark: Bark::Maple,
            r_trunk: (0.28, 0.36), lean: 0.08, gnarl: 0.12,
        },
        _ => BroadParams {
            h: (8.0, 12.0), trunk: (0.25, 0.35), crown: [0.38, 0.32, 0.38], blobs: (3, 6), att: 900, d: 0.28, trop: 0.05,
            leader: 0.2, leaf: None, lsize: (0.0, 0.0), per: 0, droop: 0.0, bark: Bark::Dead,
            r_trunk: (0.25, 0.38), lean: 0.15, gnarl: 0.3,
        },
    }
}

fn broadleaf(seed: u32, kind: TreeKind) -> Asset {
    let p = broad_params(kind);
    let mut rng = Pcg32::new(seed as u64, 0xb40a);
    let noise = Perlin::new(seed as u64 + 9);
    let h = rng.uniform(p.h.0, p.h.1);
    let d = p.d * h / 11.0;
    let trunk_top = rng.uniform(p.trunk.0, p.trunk.1) * h;
    let radii = Vec3::new(p.crown[0] * h * rng.uniform(0.88, 1.12), p.crown[1] * h * rng.uniform(0.88, 1.12), p.crown[2] * h * rng.uniform(0.88, 1.12));
    let mut center = Vec3::new(0.0, trunk_top + radii.y * 0.85, 0.0);
    if p.leader > 0.0 {
        center.y = center.y.max(h - radii.y);
    }
    let lean = [rng.gauss(p.lean), rng.gauss(p.lean)];

    // Trunk (and leader) as seed nodes.
    let top = trunk_top + p.leader * (h - trunk_top) * 0.85;
    let mut nodes = Vec::new();
    let mut y = 0.0;
    while y < top {
        let t = y / h;
        let wx = p.gnarl * noise.fbm(y * 0.25, 1.3, 0.2, 3);
        let wz = p.gnarl * noise.fbm(y * 0.25, 7.1, 0.9, 3);
        nodes.push(Vec3::new(lean[0] * y * t + wx * t, y, lean[1] * y * t + wz * t));
        y += d;
    }
    if nodes.len() < 2 {
        nodes.push(Vec3::new(0.0, d, 0.0));
    }
    let top_node = nodes[nodes.len() - 1];
    center.x += top_node.x * 0.6;
    center.z += top_node.z * 0.6;
    let blobs = rng.int(p.blobs.0, p.blobs.1);
    let att = envelope_points(&mut rng, p.att, center, radii, blobs, 0.5, Some(&noise), trunk_top * 0.9);
    // Fix for a failure mode of the original: with a lumpy (blob) crown,
    // every attraction point can be out of reach of the trunk top, and then
    // no branch ever starts (the Python version grows a bare trunk for about
    // 15% of oaks). Keep growing the trunk toward the crown until it can.
    if let Some(&near) = att.iter().min_by(|a, b| (**a - top_node).length().total_cmp(&(**b - top_node).length())) {
        let mut tip = top_node;
        while (near - tip).length() > d * 7.0 * 0.8 && nodes.len() < 400 {
            tip = tip + unit(near - tip) * d;
            nodes.push(tip);
        }
    }
    let nt = nodes.len();
    let parents: Vec<i32> = (0..nt as i32).map(|i| i - 1).collect();
    let sk = colonize(&mut rng, &att, nodes, parents, d, d * 7.0, d * 1.3, UP * p.trop, 300, 0.1);
    let (mut pts, par) = (sk.nodes, sk.parents);
    smooth(&mut pts, &par, 3, 1);
    let r_tip = 0.006;
    let mut r = pipe_radii(&par, r_tip, 2.15);
    let target = rng.uniform(p.r_trunk.0, p.r_trunk.1) * h / 11.0;
    let scale = target / r[0].max(1e-6);
    r.iter_mut().for_each(|x| *x = r_tip + (*x - r_tip) * scale);
    for i in 0..nt {
        r[i] *= 1.0 + 0.55 * (-pts[i].y / (0.35 * h / 11.0)).exp(); // root flare
    }
    let mut keep = vec![true; pts.len()];
    if kind == TreeKind::Dead {
        let rmax = r.iter().cloned().fold(0.0, f32::max);
        for i in 0..pts.len() {
            let cut = i >= nt && r[i] < rmax * 0.25 && rng.chance(0.05);
            if par[i] >= 0 && (cut || !keep[par[i] as usize]) {
                keep[i] = false;
            }
        }
    }
    let mut a = Asset::new(kind.name());
    for i in 0..pts.len() {
        if par[i] < 0 || !keep[i] {
            continue;
        }
        let level = if i < nt { 0 } else if r[i] > 0.04 { 1 } else { 2 };
        a.wood(pts[par[i] as usize], pts[i], r[i], level, p.bark);
    }
    if let Some(leaf) = p.leaf {
        for i in nt..pts.len() {
            if par[i] < 0 || !keep[i] || r[i] >= r_tip * 1.9 {
                continue;
            }
            for _ in 0..p.per {
                let dirv = unit(pts[i] - pts[par[i] as usize]);
                let out = unit(pts[i] - center);
                let mut pos = pts[i] + rng.gauss3(d * 0.55);
                if p.droop > 0.5 {
                    pos.y -= rng.uniform(0.0, d * 2.5); // birch: hanging twigs
                }
                let axis = unit(dirv + out * 0.5 + rng.gauss3(0.7) - UP * p.droop);
                let normal = unit(out * 0.7 + UP + rng.gauss3(0.6));
                let sz = rng.uniform(p.lsize.0, p.lsize.1);
                a.sprite(pos + axis * (sz * 0.4), axis, sz, leaf, Some(normal));
            }
        }
    }
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_species_is_valid_and_has_its_height() {
        let heights = [(9.0, 12.5), (10.0, 15.5), (8.0, 15.0), (10.0, 17.0), (8.0, 14.0), (6.0, 13.0)];
        for (kind, (lo, hi)) in TreeKind::ALL.into_iter().zip(heights) {
            let a = make_tree(7, kind);
            assert!(a.is_valid(), "{kind:?}");
            let h = a.height();
            assert!(h > lo && h < hi, "{kind:?} height {h}");
            assert!(a.wood.iter().any(|w| w.level == 0), "{kind:?} has a trunk");
            let leaves = a.sprites.len();
            if kind == TreeKind::Dead {
                assert!(leaves == 0);
            } else {
                assert!(leaves > 1000, "{kind:?}: {leaves} leaf sprites");
            }
        }
    }

    #[test]
    fn deterministic() {
        for kind in TreeKind::ALL {
            let (a, b) = (make_tree(3, kind), make_tree(3, kind));
            assert_eq!((a.wood.len(), a.sprites.len()), (b.wood.len(), b.sprites.len()));
            assert_eq!(a.bounds().1, b.bounds().1);
        }
    }
}

#[cfg(test)]
mod crowns {
    use super::*;

    /// The original grows a bare trunk for ~15% of oaks and ~12% of dead
    /// snags (all attraction points out of reach). The port must never.
    #[test]
    fn every_broadleaf_grows_a_crown() {
        for k in [TreeKind::Oak, TreeKind::Birch, TreeKind::Maple, TreeKind::Dead] {
            let fails: Vec<u32> = (1..=40).filter(|&s| make_tree(s, k).wood.len() < 150).collect();
            assert!(fails.is_empty(), "{k:?}: no crown for seeds {fails:?}");
        }
    }
}
