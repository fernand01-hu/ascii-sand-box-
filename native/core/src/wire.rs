//! Jobs and their results as bytes, for executors that cannot share memory
//! with the session (Web Workers). Plain little-endian fields in a fixed
//! order; both ends are this same code, so there is no versioning.

use crate::chunks::ChunkRec;
use crate::input::{Gallery, Preset};
use crate::jobs::{CardData, ChunkOut, Job, JobDone, JobKind, ModelOut, Output, SceneOut, WalkOut, WorldOut};
use crate::render_data::MaterialDef;
use ascii_engine as eng;

#[derive(Default)]
struct W(Vec<u8>);

impl W {
    fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    fn bool(&mut self, v: bool) {
        self.u8(u8::from(v));
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn i32(&mut self, v: i32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn f32(&mut self, v: f32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn f64(&mut self, v: f64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn len(&mut self, n: usize) {
        self.u32(u32::try_from(n).expect("wire: length over 4G"));
    }
    fn bytes(&mut self, v: &[u8]) {
        self.len(v.len());
        self.0.extend_from_slice(v);
    }
    fn str(&mut self, v: &str) {
        self.bytes(v.as_bytes());
    }
    fn f32s(&mut self, v: &[f32]) {
        self.len(v.len());
        for x in v {
            self.f32(*x);
        }
    }
    fn arr<const N: usize>(&mut self, v: &[f32; N]) {
        for x in v {
            self.f32(*x);
        }
    }
}

struct R<'a>(&'a [u8]);

type Res<T> = Result<T, String>;

impl R<'_> {
    fn take(&mut self, n: usize) -> Res<&[u8]> {
        if self.0.len() < n {
            return Err("wire: truncated message".into());
        }
        let (a, b) = self.0.split_at(n);
        self.0 = b;
        Ok(a)
    }
    fn fixed<const N: usize>(&mut self) -> Res<[u8; N]> {
        Ok(self.take(N)?.try_into().expect("length checked"))
    }
    fn u8(&mut self) -> Res<u8> {
        Ok(self.take(1)?[0])
    }
    fn bool(&mut self) -> Res<bool> {
        Ok(self.u8()? != 0)
    }
    fn u32(&mut self) -> Res<u32> {
        Ok(u32::from_le_bytes(self.fixed()?))
    }
    fn i32(&mut self) -> Res<i32> {
        Ok(i32::from_le_bytes(self.fixed()?))
    }
    fn u64(&mut self) -> Res<u64> {
        Ok(u64::from_le_bytes(self.fixed()?))
    }
    fn f32(&mut self) -> Res<f32> {
        Ok(f32::from_le_bytes(self.fixed()?))
    }
    fn f64(&mut self) -> Res<f64> {
        Ok(f64::from_le_bytes(self.fixed()?))
    }
    fn len(&mut self) -> Res<usize> {
        Ok(self.u32()? as usize)
    }
    fn bytes(&mut self) -> Res<Vec<u8>> {
        let n = self.len()?;
        Ok(self.take(n)?.to_vec())
    }
    fn str(&mut self) -> Res<String> {
        String::from_utf8(self.bytes()?).map_err(|_| "wire: bad utf-8".into())
    }
    fn f32s(&mut self) -> Res<Vec<f32>> {
        let n = self.len()?;
        let raw = self.take(n.checked_mul(4).ok_or("wire: bad length")?)?;
        Ok(raw.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().expect("4 bytes"))).collect())
    }
    fn arr<const N: usize>(&mut self) -> Res<[f32; N]> {
        let mut a = [0.0; N];
        for x in &mut a {
            *x = self.f32()?;
        }
        Ok(a)
    }
}

const GALLERIES: [Gallery; 4] = [Gallery::Rocks, Gallery::Plants, Gallery::Bushes, Gallery::Trees];
const PRESETS: [Preset; 5] = [Preset::Meadow, Preset::Forest, Preset::Lake, Preset::Valley, Preset::Alpine];

fn pick<T: Copy + PartialEq>(all: &[T], i: u8) -> Res<T> {
    all.get(usize::from(i)).copied().ok_or_else(|| "wire: bad enum".into())
}

fn index<T: PartialEq>(all: &[T], v: &T) -> u8 {
    all.iter().position(|x| x == v).expect("listed") as u8
}

pub fn encode_job(job: &Job) -> Vec<u8> {
    let mut w = W::default();
    w.u64(job.id);
    match &job.kind {
        JobKind::Stl { bytes, z_up, settings: s, charset } => {
            w.u8(0);
            w.bytes(bytes);
            w.bool(*z_up);
            w.u32(s.seed);
            w.u32(s.glyph_rule);
            w.arr(&[s.glyph_size, s.size_factor, s.pattern_scale, s.glyph_aspect, s.r, s.g, s.b, s.color_jitter, s.twist, s.tilt, s.alpha_min, s.alpha_max]);
            w.str(charset);
        }
        JobKind::Gallery { category, seed, aspect } => {
            w.u8(1);
            w.u8(index(&GALLERIES, category));
            w.u32(*seed);
            w.f32(*aspect);
        }
        JobKind::Scene { preset, seed, aspect } => {
            w.u8(2);
            w.u8(index(&PRESETS, preset));
            w.u32(*seed);
            w.f32(*aspect);
        }
        JobKind::WorldInit { seed, day, aspect } => {
            w.u8(3);
            w.u32(*seed);
            w.bool(*day);
            w.f32(*aspect);
        }
        JobKind::Chunk { seed, day, cx, cz, eye, aspect } => {
            w.u8(4);
            w.u32(*seed);
            w.bool(*day);
            w.i32(*cx);
            w.i32(*cz);
            w.arr(eye);
            w.f32(*aspect);
        }
        JobKind::WarmAssets { seed, part, parts } => {
            w.u8(5);
            w.u32(*seed);
            w.len(*part);
            w.len(*parts);
        }
    }
    w.0
}

pub fn decode_job(b: &[u8]) -> Res<Job> {
    let mut r = R(b);
    let id = r.u64()?;
    let kind = match r.u8()? {
        0 => {
            let bytes = r.bytes()?;
            let z_up = r.bool()?;
            let seed = r.u32()?;
            let glyph_rule = r.u32()?;
            let [glyph_size, size_factor, pattern_scale, glyph_aspect, cr, cg, cb, color_jitter, twist, tilt, alpha_min, alpha_max] = r.arr()?;
            let settings = eng::CardConfig { seed, glyph_size, size_factor, glyph_rule, pattern_scale, glyph_aspect, r: cr, g: cg, b: cb, color_jitter, twist, tilt, alpha_min, alpha_max };
            JobKind::Stl { bytes, z_up, settings, charset: r.str()? }
        }
        1 => JobKind::Gallery { category: pick(&GALLERIES, r.u8()?)?, seed: r.u32()?, aspect: r.f32()? },
        2 => JobKind::Scene { preset: pick(&PRESETS, r.u8()?)?, seed: r.u32()?, aspect: r.f32()? },
        3 => JobKind::WorldInit { seed: r.u32()?, day: r.bool()?, aspect: r.f32()? },
        4 => JobKind::Chunk { seed: r.u32()?, day: r.bool()?, cx: r.i32()?, cz: r.i32()?, eye: r.arr()?, aspect: r.f32()? },
        5 => JobKind::WarmAssets { seed: r.u32()?, part: r.len()?, parts: r.len()? },
        _ => return Err("wire: bad job kind".into()),
    };
    Ok(Job { id, kind })
}

fn put_cards(w: &mut W, c: &CardData) {
    w.f32s(&c.cards);
    w.len(c.chunks.len());
    for k in &c.chunks {
        w.u32(k.start);
        w.u32(k.count);
        w.arr(&k.lo);
        w.arr(&k.hi);
        w.f32(k.size);
        w.bool(k.global);
    }
}

fn get_cards(r: &mut R) -> Res<CardData> {
    let cards = r.f32s()?;
    let n = r.len()?;
    let mut chunks = Vec::with_capacity(n.min(1 << 16));
    for _ in 0..n {
        chunks.push(ChunkRec { start: r.u32()?, count: r.u32()?, lo: r.arr()?, hi: r.arr()?, size: r.f32()?, global: r.bool()? });
    }
    Ok(CardData { cards, chunks })
}

fn put_materials(w: &mut W, m: &[MaterialDef]) {
    w.len(m.len());
    for m in m {
        w.arr(&[m.spec, m.shininess, m.trans, m.wrap, m.billboard, m.twist, m.alpha_lit, m.haze, m.flex, m.flow, m.fog, m.chain]);
    }
}

fn get_materials(r: &mut R) -> Res<Vec<MaterialDef>> {
    let n = r.len()?;
    let mut out = Vec::with_capacity(n.min(1 << 12));
    for _ in 0..n {
        let [spec, shininess, trans, wrap, billboard, twist, alpha_lit, haze, flex, flow, fog, chain] = r.arr()?;
        out.push(MaterialDef { spec, shininess, trans, wrap, billboard, twist, alpha_lit, haze, flex, flow, fog, chain });
    }
    Ok(out)
}

pub fn encode_done(d: &JobDone) -> Vec<u8> {
    let mut w = W::default();
    w.u64(d.id);
    w.f64(d.elapsed_ms);
    match &d.output {
        Err(e) => {
            w.u8(0);
            w.str(e);
        }
        Ok(Output::Model(m)) => {
            w.u8(1);
            w.f32s(&m.positions);
            w.u32(m.triangles);
            w.u32(m.dropped);
            w.str(&m.charset);
            put_cards(&mut w, &m.cards);
        }
        Ok(Output::Scene(s)) => {
            w.u8(2);
            w.bool(s.is_scene);
            put_cards(&mut w, &s.cards);
            w.f32s(&s.body);
            w.str(&s.charset);
            put_materials(&mut w, &s.materials);
            w.arr(&s.sun_dir);
            w.arr(&s.camera);
            w.bool(s.day);
            w.arr(&s.wind_dir);
            w.arr(&s.leaf_box);
            w.arr(&s.rain_box);
            w.bool(s.walk.is_some());
            if let Some(k) = &s.walk {
                w.f32s(&k.heights);
                w.u32(k.n);
                w.f32(k.size);
                w.f32(k.water);
                w.bytes(&k.water_mask);
                w.f32s(&k.colliders);
            }
        }
        Ok(Output::World(o)) => {
            w.u8(3);
            w.u32(o.seed);
            w.bool(o.day);
            put_cards(&mut w, &o.cards);
            w.str(&o.charset);
            put_materials(&mut w, &o.materials);
            w.arr(&o.sun_dir);
            w.f32(o.chunk_size);
            w.u32(o.grid);
            w.f32(o.water);
            w.arr(&o.spawn);
        }
        Ok(Output::Chunk(c)) => {
            w.u8(4);
            w.i32(c.cx);
            w.i32(c.cz);
            w.arr(&c.eye);
            put_cards(&mut w, &c.cards);
            w.f32s(&c.body);
            w.f32s(&c.heights);
            w.f32s(&c.colliders);
        }
        Ok(Output::Warmed) => w.u8(5),
    }
    w.0
}

pub fn decode_done(b: &[u8]) -> Res<JobDone> {
    let mut r = R(b);
    let id = r.u64()?;
    let elapsed_ms = r.f64()?;
    let output = match r.u8()? {
        0 => Err(r.str()?),
        1 => Ok(Output::Model(ModelOut { positions: r.f32s()?, triangles: r.u32()?, dropped: r.u32()?, charset: r.str()?, cards: get_cards(&mut r)? })),
        2 => {
            let is_scene = r.bool()?;
            let cards = get_cards(&mut r)?;
            let body = r.f32s()?;
            let charset = r.str()?;
            let materials = get_materials(&mut r)?;
            let (sun_dir, camera, day, wind_dir, leaf_box, rain_box) = (r.arr()?, r.arr()?, r.bool()?, r.arr()?, r.arr()?, r.arr()?);
            let walk = if r.bool()? {
                Some(WalkOut { heights: r.f32s()?, n: r.u32()?, size: r.f32()?, water: r.f32()?, water_mask: r.bytes()?, colliders: r.f32s()? })
            } else {
                None
            };
            Ok(Output::Scene(Box::new(SceneOut { is_scene, cards, body, charset, materials, sun_dir, camera, day, wind_dir, leaf_box, rain_box, walk })))
        }
        3 => Ok(Output::World(WorldOut {
            seed: r.u32()?,
            day: r.bool()?,
            cards: get_cards(&mut r)?,
            charset: r.str()?,
            materials: get_materials(&mut r)?,
            sun_dir: r.arr()?,
            chunk_size: r.f32()?,
            grid: r.u32()?,
            water: r.f32()?,
            spawn: r.arr()?,
        })),
        4 => Ok(Output::Chunk(Box::new(ChunkOut {
            cx: r.i32()?,
            cz: r.i32()?,
            eye: r.arr()?,
            cards: get_cards(&mut r)?,
            body: r.f32s()?,
            heights: r.f32s()?,
            colliders: r.f32s()?,
        }))),
        5 => Ok(Output::Warmed),
        _ => return Err("wire: bad output kind".into()),
    };
    if !r.0.is_empty() {
        return Err("wire: trailing bytes".into());
    }
    Ok(JobDone { id, elapsed_ms, output })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::Worker;

    /// Every job kind survives the trip, and so does what a worker makes of it.
    #[test]
    fn jobs_and_results_round_trip() {
        let (_, stl) = ("sphere", std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/public/models/ziggurat.stl")).expect("model"));
        let kinds = vec![
            JobKind::Stl { bytes: stl, z_up: false, settings: eng::CardConfig::new(), charset: eng::default_charset() },
            JobKind::Gallery { category: Gallery::Plants, seed: 3, aspect: 0.6 },
            JobKind::Scene { preset: Preset::Meadow, seed: 1, aspect: 0.6 },
            JobKind::WorldInit { seed: 1, day: true, aspect: 0.6 },
            JobKind::Chunk { seed: 1, day: true, cx: -1, cz: 2, eye: [3.0, 2.0, 70.0], aspect: 0.6 },
            JobKind::WarmAssets { seed: 1, part: 5, parts: 6 },
        ];
        let mut worker = Worker::new();
        for (i, kind) in kinds.into_iter().enumerate() {
            let job = Job { id: 40 + i as u64, kind };
            let bytes = encode_job(&job);
            let back = decode_job(&bytes).expect("decode job");
            assert_eq!(format!("{:?}", back.kind), format!("{:?}", job.kind));
            assert_eq!(encode_job(&back), bytes);
            let done = JobDone { id: job.id, elapsed_ms: 1.5, output: worker.run(&back.kind) };
            let bytes = encode_done(&done);
            let again = decode_done(&bytes).expect("decode result");
            assert_eq!(encode_done(&again), bytes, "job kind {i}");
        }
        let err = JobDone { id: 9, elapsed_ms: 0.0, output: Err("broken".into()) };
        assert!(matches!(decode_done(&encode_done(&err)).expect("decode").output, Err(e) if e == "broken"));
        assert!(decode_done(&encode_done(&err)[..5]).is_err());
    }
}
