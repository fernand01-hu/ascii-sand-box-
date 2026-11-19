//! Spatial chunks for render-time culling: exact port of
//! `web/src/engine/chunks.ts` (16 m cells, mulberry32 shuffle).

/// Chunk side in metres.
pub const CHUNK_SIZE: f64 = 16.0;
const MATERIAL_SHIFT: f64 = 1024.0;
const MAX_MATERIALS: f64 = 64.0;

/// One culling chunk: a contiguous range of cards plus its bounds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChunkRec {
    pub start: u32,
    pub count: u32,
    pub lo: [f32; 3],
    pub hi: [f32; 3],
    /// Largest card edge (|V|).
    pub size: f32,
    /// Always drawn (sky, rain, leaves).
    pub global: bool,
}

pub struct Chunked {
    pub cards: Vec<f32>,
    pub chunks: Vec<ChunkRec>,
}

/// mulberry32, bit for bit as in JS (`Math.imul` = wrapping u32 multiply).
pub struct Mulberry32(u32);

impl Mulberry32 {
    pub fn new(seed: u32) -> Self {
        Mulberry32(seed)
    }
    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

/// Card modes that are never culled: sky (4), rain (5), leaves (6).
fn is_global_mode(mode: i64) -> bool {
    matches!(mode, 4..=6)
}

/// Group, shuffle and reorder cards; `all_global` puts everything in one chunk.
pub fn chunk_cards(cards: &[f32], stride: usize, all_global: bool) -> Chunked {
    let n = cards.len() / stride;
    const GLOBAL_KEY: i64 = 0x7fff_ffff;
    let mut key_of = vec![0u32; n];
    let mut ids: std::collections::HashMap<i64, u32> = std::collections::HashMap::new();
    let mut counts: Vec<u32> = Vec::new();
    for i in 0..n {
        let o = i * stride;
        let mode = (f64::from(cards[o + 13]) / MATERIAL_SHIFT / MAX_MATERIALS).floor() as i64;
        let mut key = GLOBAL_KEY;
        if !all_global && !is_global_mode(mode) {
            let cx = (f64::from(cards[o]) / CHUNK_SIZE).floor() as i64 + 512;
            let cz = (f64::from(cards[o + 2]) / CHUNK_SIZE).floor() as i64 + 512;
            key = cx * 1024 + cz;
        }
        let c = *ids.entry(key).or_insert_with(|| {
            counts.push(0);
            (counts.len() - 1) as u32
        });
        key_of[i] = c;
        counts[c as usize] += 1;
    }
    let mut starts = vec![0u32; counts.len()];
    for c in 1..counts.len() {
        starts[c] = starts[c - 1] + counts[c - 1];
    }
    let mut fill = starts.clone();
    let mut order = vec![0u32; n];
    for (i, &k) in key_of.iter().enumerate() {
        order[fill[k as usize] as usize] = i as u32;
        fill[k as usize] += 1;
    }
    let global_index = ids.get(&GLOBAL_KEY).copied();
    let mut out = vec![0.0f32; cards.len()];
    let mut chunks = Vec::with_capacity(counts.len());
    for c in 0..counts.len() {
        let s = starts[c] as usize;
        let m = counts[c] as usize;
        let mut r = Mulberry32::new((c as u32).wrapping_mul(7919).wrapping_add(13));
        for i in (1..m).rev() {
            let j = (r.next() * (i + 1) as f64).floor() as usize;
            order.swap(s + i, s + j);
        }
        let (mut lo, mut hi, mut size) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3], 0.0f64);
        for k in 0..m {
            let src = order[s + k] as usize * stride;
            let dst = (s + k) * stride;
            out[dst..dst + stride].copy_from_slice(&cards[src..src + stride]);
            for a in 0..3 {
                let v = cards[src + a];
                if v < lo[a] {
                    lo[a] = v;
                }
                if v > hi[a] {
                    hi[a] = v;
                }
            }
            let v = f64::from(cards[src + 6]).hypot(f64::from(cards[src + 7])).hypot(f64::from(cards[src + 8]));
            if v > size {
                size = v;
            }
        }
        chunks.push(ChunkRec {
            start: s as u32,
            count: m as u32,
            lo,
            hi,
            size: size as f32,
            global: global_index == Some(c as u32),
        });
    }
    Chunked { cards: out, chunks }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_chunk_keeps_every_card() {
        let mut cards = vec![0.0f32; 16 * 5];
        for i in 0..5 {
            cards[i * 16] = i as f32 * 40.0;
            cards[i * 16 + 9] = i as f32;
        }
        let r = chunk_cards(&cards, 16, true);
        assert_eq!(r.chunks.len(), 1);
        assert!(r.chunks[0].global);
        assert_eq!(r.chunks[0].count, 5);
    }
}
