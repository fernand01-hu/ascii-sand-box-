//! wgpu renderer for the ASCII scene. Consumes `ascii_core`'s `RenderEvent`s
//! and `FrameParams`; knows nothing about windows (the shell supplies a
//! device and a target view) and nothing about input.
//!
//! One frame: opaque bodies write depth, cards are one instanced draw per
//! visible culling chunk (persistent per-set instance buffers, no per-frame
//! allocation), after an "underpaint" pre-pass that paints a blurred colour
//! wash behind the glyphs.

pub mod atlas;
pub mod headless;

use ascii_core::chunks::ChunkRec;
use ascii_core::render_data::{CardLod, FrameParams, MaterialDef, RenderEvent, SURFACE_MATERIAL};
use ascii_core::CARD_STRIDE;
use bytemuck::{Pod, Zeroable};
use std::collections::BTreeMap;
use wgpu::util::DeviceExt;

const SHADER: &str = include_str!("cards.wgsl");
const MSAA: u32 = 4;
const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
const UNDER_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
const MAX_MATERIALS: usize = 64;
/// Bytes per card in the evaluated buffer (`CardOut` in cards.wgsl).
const CARD_OUT_BYTES: u64 = 64;
/// One `Range` per dispatch, at the uniform dynamic-offset alignment.
const RANGE_STRIDE: usize = 256;
/// Most cards in one evaluation dispatch (workgroups of 64, at most 65535 of them).
const MAX_RANGE: u32 = 64 * 65535;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct FrameUniform {
    view: [f32; 16],
    proj: [f32; 16],
    cam: [f32; 4],
    sun_dir: [f32; 4],
    sun_color: [f32; 4],
    sky_color: [f32; 4],
    glint_color: [f32; 4],
    tone: [f32; 4],
    haze_color: [f32; 4],
    fog: [f32; 4],
    wind: [f32; 4],
    weather: [f32; 4],
    rain_box: [f32; 4],
    leaf_box: [f32; 4],
    atlas: [f32; 4],
    mat_a: [[f32; 4]; MAX_MATERIALS],
    mat_b: [[f32; 4]; MAX_MATERIALS],
    mat_c: [[f32; 4]; MAX_MATERIALS],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct PostUniform {
    step: [f32; 2],
    strength: f32,
    pad: f32,
    bg: [f32; 4],
}

/// A visible draw range: cards `start..start + count` of a set.
#[derive(Clone, Copy)]
struct Visible {
    key: u64,
    /// From `outgoing` (a replaced set dissolving out) rather than `sets`.
    outgoing: bool,
    start: u32,
    count: u32,
    fade: f32,
    lod: Option<CardLod>,
}

struct CardSet {
    buf: wgpu::Buffer,
    /// Per-card evaluation (`CardOut`, 64 bytes), rewritten each frame for the visible ranges.
    out: wgpu::Buffer,
    eval_bg: wgpu::BindGroup,
    draw_bg: wgpu::BindGroup,
    chunks: Vec<ChunkRec>,
    /// Renderer clock (seconds) when this set started to fade in, or out for
    /// a replaced set kept in `outgoing`.
    fade_start: f64,
    lod: Option<CardLod>,
}

struct Body {
    buf: wgpu::Buffer,
    verts: u32,
}

struct Targets {
    size: (u32, u32),
    msaa_color: wgpu::TextureView,
    depth: wgpu::TextureView,
    under_size: (u32, u32),
    under_msaa: wgpu::TextureView,
    under_depth: wgpu::TextureView,
    under_resolve: wgpu::TextureView,
    blur_a: wgpu::TextureView,
    blur_b: wgpu::TextureView,
    blur_h_bg: wgpu::BindGroup,
    blur_v_bg: wgpu::BindGroup,
    composite_bg: wgpu::BindGroup,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct RenderStats {
    pub instances: u64,
    pub draw_calls: u32,
    pub sets: usize,
}

pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    format: wgpu::TextureFormat,
    // pipelines
    body_pipe: wgpu::RenderPipeline,
    blend_pipe: wgpu::RenderPipeline,
    coverage_pipe: wgpu::RenderPipeline,
    under_body_pipe: wgpu::RenderPipeline,
    under_pipe: wgpu::RenderPipeline,
    eval_pipe: wgpu::ComputePipeline,
    eval_layout: wgpu::BindGroupLayout,
    draw_layout: wgpu::BindGroupLayout,
    range_buf: wgpu::Buffer,
    range_cap: usize,
    quad_index: wgpu::Buffer,
    blur_pipe: wgpu::RenderPipeline,
    composite_pipe: wgpu::RenderPipeline,
    frame_layout: wgpu::BindGroupLayout,
    post_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    post_sampler: wgpu::Sampler,
    // frame state
    frame_buf: wgpu::Buffer,
    under_buf: wgpu::Buffer,
    blur_h_buf: wgpu::Buffer,
    blur_v_buf: wgpu::Buffer,
    composite_buf: wgpu::Buffer,
    frame_bg: Option<wgpu::BindGroup>,
    under_bg: Option<wgpu::BindGroup>,
    atlas_view: Option<wgpu::TextureView>,
    atlas_grid: [f32; 4],
    materials: [[[f32; 4]; MAX_MATERIALS]; 3],
    targets: Option<Targets>,
    sets: BTreeMap<u64, CardSet>,
    bodies: BTreeMap<u64, Body>,
    // reused every frame
    uniform: Box<FrameUniform>,
    visible: Vec<Visible>,
    /// Replaced sets, drawn while they dissolve into their replacement.
    outgoing: BTreeMap<u64, CardSet>,
    /// Seconds a new or replaced card set takes to dissolve in (0: at once).
    pub fade_secs: f32,
    /// Wall clock for dissolves, seconds, set by the shell (`set_clock`).
    clock: f64,
    fading: bool,
}

fn vec4(v: [f32; 3], w: f32) -> [f32; 4] {
    [v[0], v[1], v[2], w]
}

impl Renderer {
    /// `format` is the colour format of the target the frame is resolved into.
    /// Use a non-sRGB format: the shaders write final display values.
    pub fn new(device: wgpu::Device, queue: wgpu::Queue, format: wgpu::TextureFormat) -> Self {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("cards"), source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
        let entry = |ty, vis| wgpu::BindGroupLayoutEntry { binding: 0, visibility: vis, ty, count: None };
        let ubo = wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None };
        let tex = |ms: bool| wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: ms };
        let smp = wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering);
        let both = wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT;
        let mk_layout = |label: &str, vis: wgpu::ShaderStages| {
            let mut e0 = entry(ubo, vis);
            let mut e1 = entry(tex(false), wgpu::ShaderStages::FRAGMENT);
            let mut e2 = entry(smp, wgpu::ShaderStages::FRAGMENT);
            e0.binding = 0;
            e1.binding = 1;
            e2.binding = 2;
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some(label), entries: &[e0, e1, e2] })
        };
        let frame_layout = mk_layout("frame", both | wgpu::ShaderStages::COMPUTE);
        let storage = |read_only: bool| wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only }, has_dynamic_offset: false, min_binding_size: None };
        let cs = wgpu::ShaderStages::COMPUTE;
        let eval_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("card eval"),
            entries: &[
                wgpu::BindGroupLayoutEntry { binding: 0, visibility: cs, ty: storage(true), count: None },
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: cs, ty: storage(false), count: None },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: cs,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: true, min_binding_size: wgpu::BufferSize::new(32) },
                    count: None,
                },
            ],
        });
        let draw_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("card draw"),
            entries: &[wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::VERTEX, ty: storage(true), count: None }],
        });
        let post_layout = mk_layout("post", wgpu::ShaderStages::FRAGMENT);
        let frame_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("frame"), bind_group_layouts: &[&frame_layout], push_constant_ranges: &[] });
        let card_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("cards"), bind_group_layouts: &[&frame_layout, &draw_layout], push_constant_ranges: &[] });
        let eval_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("card eval"), bind_group_layouts: &[&frame_layout, &eval_layout], push_constant_ranges: &[] });
        let post_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("post"), bind_group_layouts: &[&post_layout], push_constant_ranges: &[] });

        let body_attrs = [wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 0, shader_location: 0 }];
        let body_layout = wgpu::VertexBufferLayout { array_stride: 12, step_mode: wgpu::VertexStepMode::Vertex, attributes: &body_attrs };

        let depth_state = |write: bool, compare: wgpu::CompareFunction| wgpu::DepthStencilState {
            format: DEPTH,
            depth_write_enabled: write,
            depth_compare: compare,
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        };
        let ms = |a2c: bool| wgpu::MultisampleState { count: MSAA, mask: !0, alpha_to_coverage_enabled: a2c };
        let prim = |cull: Option<wgpu::Face>| wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleList, cull_mode: cull, front_face: wgpu::FrontFace::Ccw, ..Default::default() };
        let blend = wgpu::BlendState {
            color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::SrcAlpha, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
            alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
        };
        let target = |f: wgpu::TextureFormat, b: Option<wgpu::BlendState>, mask: wgpu::ColorWrites| Some(wgpu::ColorTargetState { format: f, blend: b, write_mask: mask });
        let opts = wgpu::PipelineCompilationOptions::default();

        let body_pipe_for = |label: &str, f: wgpu::TextureFormat| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&frame_pl),
                vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_body"), compilation_options: opts.clone(), buffers: &[body_layout.clone()] },
                fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_body"), compilation_options: opts.clone(), targets: &[target(f, None, wgpu::ColorWrites::empty())] }),
                primitive: prim(Some(wgpu::Face::Back)),
                depth_stencil: Some(depth_state(true, wgpu::CompareFunction::LessEqual)),
                multisample: ms(false),
                multiview: None,
                cache: None,
            })
        };
        let card_pipe_for = |label: &str, f: wgpu::TextureFormat, fs: &str, b: Option<wgpu::BlendState>, write: bool, a2c: bool| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&card_pl),
                vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_card"), compilation_options: opts.clone(), buffers: &[] },
                fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some(fs), compilation_options: opts.clone(), targets: &[target(f, b, wgpu::ColorWrites::ALL)] }),
                primitive: prim(Some(wgpu::Face::Back)),
                depth_stencil: Some(depth_state(write, wgpu::CompareFunction::LessEqual)),
                multisample: ms(a2c),
                multiview: None,
                cache: None,
            })
        };
        let body_pipe = body_pipe_for("body", format);
        let under_body_pipe = body_pipe_for("under body", UNDER_FORMAT);
        let blend_pipe = card_pipe_for("cards blend", format, "fs_main", Some(blend), false, false);
        let coverage_pipe = card_pipe_for("cards coverage", format, "fs_main", None, true, true);
        let under_pipe = card_pipe_for("underpaint cards", UNDER_FORMAT, "fs_solid", None, true, true);
        let fullscreen = |label: &str, fs: &str, f: wgpu::TextureFormat, samples: u32, depth: bool| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&post_pl),
                vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_full"), compilation_options: opts.clone(), buffers: &[] },
                fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some(fs), compilation_options: opts.clone(), targets: &[target(f, None, wgpu::ColorWrites::ALL)] }),
                primitive: prim(None),
                depth_stencil: depth.then(|| depth_state(false, wgpu::CompareFunction::Always)),
                multisample: wgpu::MultisampleState { count: samples, mask: !0, alpha_to_coverage_enabled: false },
                multiview: None,
                cache: None,
            })
        };
        let eval_pipe = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("card eval"),
            layout: Some(&eval_pl),
            module: &module,
            entry_point: Some("cs_cards"),
            compilation_options: opts.clone(),
            cache: None,
        });
        let blur_pipe = fullscreen("blur", "fs_blur", UNDER_FORMAT, 1, false);
        let composite_pipe = fullscreen("composite", "fs_composite", format, MSAA, true);

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("atlas"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            anisotropy_clamp: 16,
            ..Default::default()
        });
        let post_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("post"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let ubuf = |label: &str, size: usize| device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: size as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let fsz = std::mem::size_of::<FrameUniform>();
        let psz = std::mem::size_of::<PostUniform>();
        let range_cap = 1024;
        let range_buf = device.create_buffer(&wgpu::BufferDescriptor { label: Some("card ranges"), size: (range_cap * RANGE_STRIDE) as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let quad_index = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("quad index"), contents: bytemuck::cast_slice(&[0u16, 1, 2, 0, 2, 3]), usage: wgpu::BufferUsages::INDEX });
        let mut r = Renderer {
            eval_pipe,
            eval_layout,
            draw_layout,
            range_buf,
            range_cap,
            quad_index,
            frame_buf: ubuf("frame", fsz),
            under_buf: ubuf("frame under", fsz),
            blur_h_buf: ubuf("blur h", psz),
            blur_v_buf: ubuf("blur v", psz),
            composite_buf: ubuf("composite", psz),
            device,
            queue,
            format,
            body_pipe,
            blend_pipe,
            coverage_pipe,
            under_body_pipe,
            under_pipe,
            blur_pipe,
            composite_pipe,
            frame_layout,
            post_layout,
            sampler,
            post_sampler,
            frame_bg: None,
            under_bg: None,
            atlas_view: None,
            atlas_grid: [1.0, 1.0, 0.0, 0.0],
            materials: [[[0.0; 4]; MAX_MATERIALS]; 3],
            targets: None,
            sets: BTreeMap::new(),
            bodies: BTreeMap::new(),
            uniform: Box::new(Zeroable::zeroed()),
            visible: Vec::with_capacity(4096),
            outgoing: BTreeMap::new(),
            fade_secs: 0.0,
            clock: 0.0,
            fading: false,
        };
        r.set_materials(&[SURFACE_MATERIAL]);
        r.set_atlas("#").expect("fallback atlas");
        r
    }

    /// A card set is still dissolving: keep drawing frames.
    /// Wall-clock time in seconds (any origin), for dissolves. The renderer
    /// reads no clock itself, so it runs the same in a browser.
    pub fn set_clock(&mut self, secs: f64) {
        self.clock = secs;
    }

    pub fn fading(&self) -> bool {
        self.fading
    }
    pub fn device(&self) -> &wgpu::Device {
        &self.device
    }
    pub fn queue(&self) -> &wgpu::Queue {
        &self.queue
    }

    pub fn set_atlas(&mut self, charset: &str) -> Result<(), String> {
        let a = atlas::build_atlas(charset)?;
        let tex = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("glyph atlas"),
            size: wgpu::Extent3d { width: a.width, height: a.height, depth_or_array_layers: 1 },
            mip_level_count: a.mips.len() as u32,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        for (level, (w, h, data)) in a.mips.iter().enumerate() {
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo { texture: &tex, mip_level: level as u32, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                data,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(*w), rows_per_image: Some(*h) },
                wgpu::Extent3d { width: *w, height: *h, depth_or_array_layers: 1 },
            );
        }
        let inset = a.inset();
        self.atlas_grid = [a.cols as f32, a.rows as f32, inset[0], inset[1]];
        self.atlas_view = Some(tex.create_view(&wgpu::TextureViewDescriptor::default()));
        self.frame_bg = None;
        self.under_bg = None;
        Ok(())
    }

    pub fn set_materials(&mut self, defs: &[MaterialDef]) {
        for i in 0..MAX_MATERIALS {
            let m = defs.get(i).copied().unwrap_or(SURFACE_MATERIAL);
            self.materials[0][i] = [m.spec, m.shininess, m.trans, m.wrap];
            self.materials[1][i] = [m.billboard, m.twist, m.alpha_lit, m.haze];
            self.materials[2][i] = [m.flex, m.flow, m.fog, m.chain];
        }
    }

    /// Apply (and drain) the core's pending updates.
    pub fn apply_events(&mut self, events: &mut Vec<RenderEvent>) {
        for e in events.drain(..) {
            match e {
                RenderEvent::SetAtlas { charset } => {
                    if let Err(err) = self.set_atlas(&charset) {
                        eprintln!("[ascii] atlas: {err}");
                    }
                }
                RenderEvent::SetMaterials(m) => self.set_materials(&m),
                RenderEvent::SetCards { key, cards, chunks, lod } => {
                    if cards.is_empty() {
                        self.sets.remove(&key);
                        self.outgoing.remove(&key);
                        continue;
                    }
                    let now = self.clock;
                    let buf = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("cards"), contents: bytemuck::cast_slice(&cards), usage: wgpu::BufferUsages::STORAGE });
                    let n = (cards.len() / CARD_STRIDE) as u64;
                    let out = self.device.create_buffer(&wgpu::BufferDescriptor { label: Some("cards eval"), size: n.max(1) * CARD_OUT_BYTES, usage: wgpu::BufferUsages::STORAGE, mapped_at_creation: false });
                    let eval_bg = self.make_eval_bg(&buf, &out);
                    let draw_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("card draw"),
                        layout: &self.draw_layout,
                        entries: &[wgpu::BindGroupEntry { binding: 0, resource: out.as_entire_binding() }],
                    });
                    let old = self.sets.insert(key, CardSet { buf, out, eval_bg, draw_bg, chunks, fade_start: now, lod });
                    if let (Some(mut old), true) = (old, self.fade_secs > 0.0) {
                        // Keep the replaced version until the new one has dissolved in.
                        old.fade_start = now;
                        self.outgoing.insert(key, old);
                    }
                }
                RenderEvent::RemoveCards { key } => {
                    self.sets.remove(&key);
                    self.outgoing.remove(&key);
                }
                RenderEvent::ClearCards => {
                    self.sets.clear();
                    self.outgoing.clear();
                }
                RenderEvent::SetBody { key, positions } => {
                    if positions.is_empty() {
                        self.bodies.remove(&key);
                        continue;
                    }
                    let verts = (positions.len() / 3) as u32;
                    let buf = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("body"), contents: bytemuck::cast_slice(&positions), usage: wgpu::BufferUsages::VERTEX });
                    self.bodies.insert(key, Body { buf, verts });
                }
                RenderEvent::RemoveBody { key } => {
                    self.bodies.remove(&key);
                }
                RenderEvent::ClearBodies => self.bodies.clear(),
            }
        }
    }

    fn make_eval_bg(&self, input: &wgpu::Buffer, out: &wgpu::Buffer) -> wgpu::BindGroup {
        self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("card eval"),
            layout: &self.eval_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: input.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: out.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &self.range_buf, offset: 0, size: wgpu::BufferSize::new(32) }) },
            ],
        })
    }

    /// Evaluate every visible card once (wind, billboards, lighting, fog...):
    /// both card passes then only expand the four corners.
    fn eval_cards(&mut self, encoder: &mut wgpu::CommandEncoder) {
        if self.visible.len() > self.range_cap {
            self.range_cap = self.visible.len().next_power_of_two();
            self.range_buf = self.device.create_buffer(&wgpu::BufferDescriptor { label: Some("card ranges"), size: (self.range_cap * RANGE_STRIDE) as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
            for outgoing in [false, true] {
                let keys: Vec<u64> = if outgoing { &self.outgoing } else { &self.sets }.keys().copied().collect();
                for k in keys {
                    let s = &if outgoing { &self.outgoing } else { &self.sets }[&k];
                    let bg = self.make_eval_bg(&s.buf, &s.out);
                    if outgoing { &mut self.outgoing } else { &mut self.sets }.get_mut(&k).expect("set").eval_bg = bg;
                }
            }
        }
        if self.visible.is_empty() {
            return;
        }
        let mut ranges = vec![0u8; self.visible.len() * RANGE_STRIDE];
        for (i, v) in self.visible.iter().enumerate() {
            ranges[i * RANGE_STRIDE..i * RANGE_STRIDE + 8].copy_from_slice(bytemuck::cast_slice(&[v.start, v.count]));
            ranges[i * RANGE_STRIDE + 8..i * RANGE_STRIDE + 12].copy_from_slice(bytemuck::bytes_of(&v.fade));
            let lod = v.lod.map_or([0.0; 5], |l| [l.far, l.eye[0], l.eye[1], l.eye[2], l.near]);
            ranges[i * RANGE_STRIDE + 12..i * RANGE_STRIDE + 32].copy_from_slice(bytemuck::cast_slice(&lod));
        }
        self.queue.write_buffer(&self.range_buf, 0, &ranges);
        let frame_bg = self.frame_bg.as_ref().expect("bg");
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("card eval"), timestamp_writes: None });
        pass.set_pipeline(&self.eval_pipe);
        pass.set_bind_group(0, frame_bg, &[]);
        for (i, v) in self.visible.iter().enumerate() {
            let Some(s) = if v.outgoing { &self.outgoing } else { &self.sets }.get(&v.key) else { continue };
            pass.set_bind_group(1, &s.eval_bg, &[(i * RANGE_STRIDE) as u32]);
            pass.dispatch_workgroups(v.count.div_ceil(64), 1, 1);
        }
    }

    fn post_bg(&self, buf: &wgpu::Buffer, view: &wgpu::TextureView) -> wgpu::BindGroup {
        self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("post"),
            layout: &self.post_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.post_sampler) },
            ],
        })
    }

    fn make_targets(&self, w: u32, h: u32) -> Targets {
        let tex = |label: &str, w: u32, h: u32, f: wgpu::TextureFormat, samples: u32, usage: wgpu::TextureUsages| {
            self.device
                .create_texture(&wgpu::TextureDescriptor {
                    label: Some(label),
                    size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                    mip_level_count: 1,
                    sample_count: samples,
                    dimension: wgpu::TextureDimension::D2,
                    format: f,
                    usage,
                    view_formats: &[],
                })
                .create_view(&wgpu::TextureViewDescriptor::default())
        };
        let rt = wgpu::TextureUsages::RENDER_ATTACHMENT;
        let rts = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
        let (uw, uh) = ((w / 2).max(1), (h / 2).max(1));
        let under_resolve = tex("under resolve", uw, uh, UNDER_FORMAT, 1, rts);
        let blur_a = tex("blur a", uw, uh, UNDER_FORMAT, 1, rts);
        let blur_b = tex("blur b", uw, uh, UNDER_FORMAT, 1, rts);
        let blur_h_bg = self.post_bg(&self.blur_h_buf, &under_resolve);
        let blur_v_bg = self.post_bg(&self.blur_v_buf, &blur_a);
        let composite_bg = self.post_bg(&self.composite_buf, &blur_b);
        Targets {
            size: (w, h),
            msaa_color: tex("msaa color", w, h, self.format, MSAA, rt),
            depth: tex("depth", w, h, DEPTH, MSAA, rt),
            under_size: (uw, uh),
            under_msaa: tex("under msaa", uw, uh, UNDER_FORMAT, MSAA, rt),
            under_depth: tex("under depth", uw, uh, DEPTH, MSAA, rt),
            under_resolve,
            blur_a,
            blur_b,
            blur_h_bg,
            blur_v_bg,
            composite_bg,
        }
    }

    fn fill_uniform(&mut self, f: &FrameParams, under: bool) {
        let u = &mut *self.uniform;
        u.view = f.view;
        u.proj = f.proj;
        u.cam = vec4(f.camera_pos, 0.0);
        u.sun_dir = vec4(f.lighting.sun_dir, 0.0);
        u.sun_color = vec4(f.lighting.sun_color, 0.0);
        u.sky_color = vec4(f.lighting.sky_color, 0.0);
        u.glint_color = vec4(f.lighting.glint_color, 0.0);
        u.tone = [f.lighting.exposure, f.lighting.sky_gain, f.lighting.ambient, f.lighting.hemi];
        u.haze_color = vec4(f.env.haze_color, 110.0);
        u.fog = [f.env.fog_dist, f.env.fog, f.alpha_gain, f.depth_bias];
        let len = f.env.wind_dir[0].hypot(f.env.wind_dir[1]);
        let len = if len == 0.0 { 1.0 } else { len };
        u.wind = [f.env.wind_dir[0] / len, f.env.wind_dir[1] / len, f.env.wind, f.time];
        u.weather = [f.env.rain, f.env.leaves, if under { 1.0 } else { 0.0 }, f.underpaint_card_alpha];
        u.rain_box = vec4(f.env.rain_box, 0.0);
        u.leaf_box = vec4(f.env.leaf_box, 0.0);
        u.atlas = self.atlas_grid;
        u.mat_a = self.materials[0];
        u.mat_b = self.materials[1];
        u.mat_c = self.materials[2];
    }

    /// Visible draw ranges (set key, first card, card count), merged where contiguous.
    fn cull(&mut self, f: &FrameParams) -> u64 {
        let vp = glam::Mat4::from_cols_array(&f.proj) * glam::Mat4::from_cols_array(&f.view);
        let r = |i: usize| vp.row(i);
        // Gribb-Hartmann for a 0..1 depth range.
        let planes = [r(3) + r(0), r(3) - r(0), r(3) + r(1), r(3) - r(1), r(2), r(3) - r(2)];
        let planes = planes.map(|p| p / p.truncate().length().max(1e-12));
        self.visible.clear();
        let mut total = 0u64;
        let now = self.clock;
        let fade_secs = f64::from(self.fade_secs);
        let progress = |s: &CardSet| if fade_secs > 0.0 { ((now - s.fade_start) / fade_secs).min(1.0) as f32 } else { 1.0 };
        self.outgoing.retain(|_, s| progress(s) < 1.0);
        self.fading = !self.outgoing.is_empty() || self.sets.values().any(|s| progress(s) < 1.0);
        for (&key, set, outgoing) in self.sets.iter().map(|(k, s)| (k, s, false)).chain(self.outgoing.iter().map(|(k, s)| (k, s, true))) {
            // `fade`: 1 fully shown; below 1 dissolving in; negative dissolving out.
            let t = progress(set);
            let fade = if outgoing { -t.max(1e-6) } else { t };
            let start_len = self.visible.len();
            for c in &set.chunks {
                let keep = c.global || {
                    let lo = glam::Vec3::from(c.lo);
                    let hi = glam::Vec3::from(c.hi);
                    let centre = (lo + hi) * 0.5;
                    let radius = lo.distance(hi) / 2.0 + c.size + 1.0;
                    planes.iter().all(|p| p.truncate().dot(centre) + p.w >= -radius)
                };
                if !keep {
                    continue;
                }
                total += u64::from(c.count);
                if self.visible.len() > start_len {
                    let last = self.visible.last_mut().expect("non-empty");
                    // Merged ranges stay within one compute dispatch (65535 groups of 64).
                    if last.start + last.count == c.start && last.count + c.count <= MAX_RANGE {
                        last.count += c.count;
                        continue;
                    }
                }
                self.visible.push(Visible { key, outgoing, start: c.start, count: c.count, fade, lod: set.lod });
            }
        }
        total
    }

    /// Draw one frame into `target` (single-sample, `format`).
    pub fn render(&mut self, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, size: (u32, u32), f: &FrameParams) -> RenderStats {
        let (w, h) = (size.0.max(1), size.1.max(1));
        if self.targets.as_ref().map(|t| t.size) != Some((w, h)) {
            self.targets = Some(self.make_targets(w, h));
        }
        let instances = self.cull(f);

        self.fill_uniform(f, false);
        self.queue.write_buffer(&self.frame_buf, 0, bytemuck::bytes_of(&*self.uniform));
        self.fill_uniform(f, true);
        self.queue.write_buffer(&self.under_buf, 0, bytemuck::bytes_of(&*self.uniform));
        let t = self.targets.as_ref().expect("targets");
        let (uw, uh) = t.under_size;
        let post = |step: [f32; 2], strength: f32, bg: [f32; 3]| PostUniform { step, strength, pad: 0.0, bg: vec4(bg, 1.0) };
        self.queue.write_buffer(&self.blur_h_buf, 0, bytemuck::bytes_of(&post([1.0 / uw as f32, 0.0], 0.0, [0.0; 3])));
        self.queue.write_buffer(&self.blur_v_buf, 0, bytemuck::bytes_of(&post([0.0, 1.0 / uh as f32], 0.0, [0.0; 3])));
        self.queue.write_buffer(&self.composite_buf, 0, bytemuck::bytes_of(&post([0.0; 2], f.underpaint_strength, f.background)));

        let atlas = self.atlas_view.as_ref().expect("atlas");
        let make_bg = |buf: &wgpu::Buffer| {
            self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("frame"),
                layout: &self.frame_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: buf.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(atlas) },
                    wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                ],
            })
        };
        if self.frame_bg.is_none() {
            self.frame_bg = Some(make_bg(&self.frame_buf));
            self.under_bg = Some(make_bg(&self.under_buf));
        }
        self.eval_cards(encoder);
        let frame_bg = self.frame_bg.as_ref().expect("bg");
        let under_bg = self.under_bg.as_ref().expect("bg");
        let t = self.targets.as_ref().expect("targets");
        let mut draw_calls = 0u32;

        // 1. Underpaint: solid card colours, half resolution, against the same bodies.
        if f.underpaint {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("underpaint"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &t.under_msaa,
                    depth_slice: None,
                    resolve_target: Some(&t.under_resolve),
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Discard },
                })],
                depth_stencil_attachment: Some(depth_att(&t.under_depth)),
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_bind_group(0, under_bg, &[]);
            pass.set_pipeline(&self.under_body_pipe);
            for b in self.bodies.values() {
                pass.set_vertex_buffer(0, b.buf.slice(..));
                pass.draw(0..b.verts, 0..1);
                draw_calls += 1;
            }
            pass.set_pipeline(&self.under_pipe);
            draw_cards(&mut pass, &self.sets, &self.outgoing, &self.visible, &self.quad_index, &mut draw_calls);
            drop(pass);
            for (pipe, bg, dst) in [(&self.blur_pipe, &t.blur_h_bg, &t.blur_a), (&self.blur_pipe, &t.blur_v_bg, &t.blur_b)] {
                let mut p = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("blur"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: dst, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
                p.set_pipeline(pipe);
                p.set_bind_group(0, bg, &[]);
                p.draw(0..3, 0..1);
            }
        }

        // 2. Background (+ wash), bodies, glyphs.
        let bg = f.background;
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("scene"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &t.msaa_color,
                depth_slice: None,
                resolve_target: Some(target),
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: f64::from(bg[0]), g: f64::from(bg[1]), b: f64::from(bg[2]), a: 1.0 }), store: wgpu::StoreOp::Discard },
            })],
            depth_stencil_attachment: Some(depth_att(&t.depth)),
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        if f.underpaint {
            pass.set_pipeline(&self.composite_pipe);
            pass.set_bind_group(0, &t.composite_bg, &[]);
            pass.draw(0..3, 0..1);
        }
        pass.set_bind_group(0, frame_bg, &[]);
        pass.set_pipeline(&self.body_pipe);
        for b in self.bodies.values() {
            pass.set_vertex_buffer(0, b.buf.slice(..));
            pass.draw(0..b.verts, 0..1);
            draw_calls += 1;
        }
        pass.set_pipeline(if f.coverage { &self.coverage_pipe } else { &self.blend_pipe });
        draw_cards(&mut pass, &self.sets, &self.outgoing, &self.visible, &self.quad_index, &mut draw_calls);
        drop(pass);
        RenderStats { instances, draw_calls, sets: self.sets.len() }
    }
}

fn draw_cards(pass: &mut wgpu::RenderPass<'_>, sets: &BTreeMap<u64, CardSet>, outgoing: &BTreeMap<u64, CardSet>, visible: &[Visible], quad: &wgpu::Buffer, calls: &mut u32) {
    let mut bound = None;
    pass.set_index_buffer(quad.slice(..), wgpu::IndexFormat::Uint16);
    for v in visible {
        if bound != Some((v.key, v.outgoing)) {
            let Some(s) = if v.outgoing { outgoing } else { sets }.get(&v.key) else { continue };
            pass.set_bind_group(1, &s.draw_bg, &[]);
            bound = Some((v.key, v.outgoing));
        }
        pass.draw_indexed(0..6, 0, v.start..v.start + v.count);
        *calls += 1;
    }
}

fn depth_att(view: &wgpu::TextureView) -> wgpu::RenderPassDepthStencilAttachment<'_> {
    wgpu::RenderPassDepthStencilAttachment {
        view,
        depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }),
        stencil_ops: None,
    }
}
