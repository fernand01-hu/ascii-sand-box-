//! STL reader (binary and ASCII). Never panics on bad input: every failure is
//! an `StlError`.

use crate::math::Vec3;
use std::fmt;

/// Hard cap so a hostile or corrupt file can't exhaust memory.
pub const MAX_TRIANGLES: usize = 4_000_000;

#[derive(Debug, Clone, PartialEq)]
pub enum StlError {
    Empty,
    TooManyTriangles(usize),
    Truncated { declared: usize, available: usize },
    Ascii(String),
    NoTriangles,
}

impl fmt::Display for StlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StlError::Empty => write!(f, "file is empty or too small to be an STL"),
            StlError::TooManyTriangles(n) => {
                write!(f, "STL has {n} triangles, the limit is {MAX_TRIANGLES}")
            }
            StlError::Truncated { declared, available } => write!(
                f,
                "binary STL declares {declared} triangles but only {available} are present"
            ),
            StlError::Ascii(m) => write!(f, "invalid ASCII STL: {m}"),
            StlError::NoTriangles => write!(f, "STL contains no triangles"),
        }
    }
}

impl std::error::Error for StlError {}

pub type Triangle = [Vec3; 3];

pub fn parse(bytes: &[u8]) -> Result<Vec<Triangle>, StlError> {
    if bytes.len() < 15 {
        return Err(StlError::Empty);
    }
    // A binary STL whose size matches its triangle count exactly is binary,
    // even if its 80-byte header happens to start with "solid".
    if bytes.len() >= 84 {
        let n = binary_count(bytes);
        if 84 + 50 * n == bytes.len() {
            return parse_binary(bytes);
        }
    }
    if looks_ascii(bytes) {
        return parse_ascii(bytes);
    }
    if bytes.len() >= 84 {
        // Binary with trailing garbage, or truncated: parse_binary decides.
        return parse_binary(bytes);
    }
    Err(StlError::Empty)
}

fn binary_count(bytes: &[u8]) -> usize {
    u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize
}

fn looks_ascii(bytes: &[u8]) -> bool {
    let start = bytes.iter().position(|b| !b.is_ascii_whitespace()).unwrap_or(bytes.len());
    let head = &bytes[start..bytes.len().min(start + 5)];
    head.eq_ignore_ascii_case(b"solid")
}

fn parse_binary(bytes: &[u8]) -> Result<Vec<Triangle>, StlError> {
    let declared = binary_count(bytes);
    let available = (bytes.len() - 84) / 50;
    if declared > MAX_TRIANGLES {
        return Err(StlError::TooManyTriangles(declared));
    }
    if declared > available {
        return Err(StlError::Truncated { declared, available });
    }
    if declared == 0 {
        return Err(StlError::NoTriangles);
    }
    let f = |o: usize| f32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
    let v = |o: usize| Vec3::new(f(o), f(o + 4), f(o + 8));
    let mut tris = Vec::with_capacity(declared);
    for i in 0..declared {
        let o = 84 + i * 50 + 12; // skip the stored normal, we recompute it
        tris.push([v(o), v(o + 12), v(o + 24)]);
    }
    Ok(tris)
}

fn parse_ascii(bytes: &[u8]) -> Result<Vec<Triangle>, StlError> {
    // Lossy: a stray non-UTF8 byte in a comment shouldn't reject the file.
    let text = String::from_utf8_lossy(bytes);
    let mut tokens = text.split_ascii_whitespace();
    let mut tris = Vec::new();
    let mut corners: Vec<Vec3> = Vec::with_capacity(3);
    while let Some(tok) = tokens.next() {
        if tok.eq_ignore_ascii_case("vertex") {
            let mut c = [0.0f32; 3];
            for slot in &mut c {
                let t = tokens.next().ok_or_else(|| StlError::Ascii("vertex is missing coordinates".into()))?;
                *slot = t
                    .parse::<f32>()
                    .map_err(|_| StlError::Ascii(format!("bad number {t:?}")))?;
            }
            corners.push(Vec3::new(c[0], c[1], c[2]));
        } else if tok.eq_ignore_ascii_case("endloop") {
            // Polygons with more than 3 vertices are fanned into triangles.
            if corners.len() >= 3 {
                for k in 1..corners.len() - 1 {
                    tris.push([corners[0], corners[k], corners[k + 1]]);
                }
            }
            corners.clear();
            if tris.len() > MAX_TRIANGLES {
                return Err(StlError::TooManyTriangles(tris.len()));
            }
        }
    }
    if tris.is_empty() {
        return Err(StlError::NoTriangles);
    }
    Ok(tris)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn binary_stl(tris: &[Triangle], header: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; 80];
        out[..header.len()].copy_from_slice(header);
        out.extend_from_slice(&(tris.len() as u32).to_le_bytes());
        for t in tris {
            out.extend_from_slice(&[0u8; 12]);
            for v in t {
                for c in [v.x, v.y, v.z] {
                    out.extend_from_slice(&c.to_le_bytes());
                }
            }
            out.extend_from_slice(&[0u8; 2]);
        }
        out
    }

    fn tri() -> Triangle {
        [Vec3::ZERO, Vec3::X, Vec3::Y]
    }

    #[test]
    fn binary_roundtrip() {
        let t = parse(&binary_stl(&[tri(), tri()], b"")).unwrap();
        assert_eq!(t.len(), 2);
        assert_eq!(t[0], tri());
    }

    #[test]
    fn binary_with_solid_header_is_still_binary() {
        let t = parse(&binary_stl(&[tri()], b"solid exported by some CAD tool")).unwrap();
        assert_eq!(t.len(), 1);
    }

    #[test]
    fn binary_trailing_bytes_ok() {
        let mut b = binary_stl(&[tri()], b"");
        b.extend_from_slice(b"junk");
        assert_eq!(parse(&b).unwrap().len(), 1);
    }

    #[test]
    fn binary_truncated() {
        let mut b = binary_stl(&[tri(), tri()], b"");
        b.truncate(84 + 60);
        assert!(matches!(parse(&b), Err(StlError::Truncated { .. })));
    }

    #[test]
    fn binary_huge_count_rejected_without_allocating() {
        let mut b = binary_stl(&[tri()], b"");
        b[80..84].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(matches!(parse(&b), Err(StlError::TooManyTriangles(_))));
    }

    #[test]
    fn ascii_basic_and_quad() {
        let s = "solid t\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n   vertex 1 1 0\n   vertex 0 1 0\n  endloop\n endfacet\nendsolid t\n";
        let t = parse(s.as_bytes()).unwrap();
        assert_eq!(t.len(), 2);
        assert_eq!(t[1][2], Vec3::new(0.0, 1.0, 0.0));
    }

    #[test]
    fn ascii_errors() {
        assert!(matches!(parse(b"solid x\nvertex 1 2\n"), Err(StlError::Ascii(_))));
        assert!(matches!(parse(b"solid x\nvertex 1 2 abc\n"), Err(StlError::Ascii(_))));
        assert!(matches!(parse(b"solid x\nendsolid x\n"), Err(StlError::NoTriangles)));
    }

    #[test]
    fn garbage_never_panics() {
        let mut r = crate::rng::Pcg32::new(1, 1);
        for len in [0usize, 1, 14, 15, 83, 84, 85, 133, 134, 500, 5000] {
            for _ in 0..50 {
                let b: Vec<u8> = (0..len).map(|_| r.next_u32() as u8).collect();
                let _ = parse(&b);
            }
        }
    }
}
