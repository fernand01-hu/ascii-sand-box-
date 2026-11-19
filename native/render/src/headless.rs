//! Off-screen rendering: no window, no surface. Used by the tests, the golden
//! comparison and the benchmark tool (works with a software Vulkan driver).

use crate::Renderer;
use ascii_core::render_data::FrameParams;

/// A non-sRGB colour target we can read back.
pub const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub adapter_info: wgpu::AdapterInfo,
}

/// Open the default adapter without a surface (honours `WGPU_BACKEND`).
pub fn open_gpu() -> Result<Gpu, String> {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor { backends: wgpu::Backends::from_env().unwrap_or_default(), ..Default::default() });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, force_fallback_adapter: false, compatible_surface: None }))
        .map_err(|e| format!("no GPU adapter: {e}"))?;
    let limits = adapter.limits();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("ascii"),
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits { max_buffer_size: limits.max_buffer_size.min(1 << 30), ..wgpu::Limits::default() },
        ..Default::default()
    }))
    .map_err(|e| e.to_string())?;
    Ok(Gpu { adapter_info: adapter.get_info(), device, queue })
}

pub struct Headless {
    pub renderer: Renderer,
    target: wgpu::Texture,
    view: wgpu::TextureView,
    readback: wgpu::Buffer,
    pub size: (u32, u32),
    padded_row: u32,
}

impl Headless {
    pub fn new(gpu: &Gpu, size: (u32, u32)) -> Self {
        let renderer = Renderer::new(gpu.device.clone(), gpu.queue.clone(), FORMAT);
        let target = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("headless target"),
            size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = target.create_view(&wgpu::TextureViewDescriptor::default());
        let padded_row = (size.0 * 4).div_ceil(256) * 256;
        let readback = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("readback"), size: u64::from(padded_row * size.1), usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        Headless { renderer, target, view, readback, size, padded_row }
    }

    /// Render one frame and return tightly packed RGBA8 rows (top row first).
    pub fn render_rgba(&mut self, f: &FrameParams) -> (Vec<u8>, crate::RenderStats) {
        let device = self.renderer.device().clone();
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
        let stats = self.renderer.render(&mut enc, &self.view, self.size, f);
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture: &self.target, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo { buffer: &self.readback, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(self.padded_row), rows_per_image: Some(self.size.1) } },
            wgpu::Extent3d { width: self.size.0, height: self.size.1, depth_or_array_layers: 1 },
        );
        self.renderer.queue().submit([enc.finish()]);
        let slice = self.readback.slice(..);
        slice.map_async(wgpu::MapMode::Read, |r| r.expect("map readback"));
        device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        let data = slice.get_mapped_range();
        let row = (self.size.0 * 4) as usize;
        let mut out = Vec::with_capacity(row * self.size.1 as usize);
        for y in 0..self.size.1 as usize {
            out.extend_from_slice(&data[y * self.padded_row as usize..y * self.padded_row as usize + row]);
        }
        drop(data);
        self.readback.unmap();
        (out, stats)
    }
}

/// Block-average an RGBA8 image into a `w` x `h` RGB thumbnail, top row first
/// (the layout the webapp's golden files use, flipped: they start at the bottom).
pub fn thumbnail(rgba: &[u8], size: (u32, u32), w: u32, h: u32) -> Vec<f64> {
    let mut sums = vec![0.0f64; (w * h * 3) as usize];
    let mut counts = vec![0.0f64; (w * h) as usize];
    for y in 0..size.1 {
        let ty = ((u64::from(y) * u64::from(h)) / u64::from(size.1)).min(u64::from(h) - 1) as u32;
        for x in 0..size.0 {
            let tx = ((u64::from(x) * u64::from(w)) / u64::from(size.0)).min(u64::from(w) - 1) as u32;
            let t = (ty * w + tx) as usize;
            let i = ((y * size.0 + x) * 4) as usize;
            for c in 0..3 {
                sums[t * 3 + c] += f64::from(rgba[i + c]);
            }
            counts[t] += 1.0;
        }
    }
    sums.iter().enumerate().map(|(k, s)| (s / counts[k / 3].max(1.0)).round()).collect()
}

pub fn read_golden(path: &std::path::Path) -> Result<Vec<f64>, String> {
    let s = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let start = s.find('[').ok_or("no data")?;
    let end = s.rfind(']').ok_or("no data")?;
    s[start + 1..end].split(',').map(|v| v.trim().parse::<f64>().map_err(|e| e.to_string())).collect()
}

/// Mean absolute difference over tiles where either image shows content
/// (the webapp's `contentDiff`).
pub fn content_diff(a: &[f64], b: &[f64]) -> f64 {
    let bg = [9.0, 12.0, 19.0];
    let (mut sum, mut n) = (0.0, 0.0);
    for t in (0..a.len()).step_by(3) {
        let content = (0..3).any(|k| (a[t + k] - bg[k]).abs() > 6.0 || (b[t + k] - bg[k]).abs() > 6.0);
        if !content {
            continue;
        }
        for k in 0..3 {
            sum += (a[t + k] - b[t + k]).abs();
        }
        n += 3.0;
    }
    if n > 0.0 { sum / n } else { 0.0 }
}

