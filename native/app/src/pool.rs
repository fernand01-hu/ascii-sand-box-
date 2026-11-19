//! Desktop job executor: a few long-lived threads, each with its own
//! `Worker` (engine + world generator), fed from one queue. Results come back
//! on a channel and are drained by `poll` on the render thread, which never
//! waits for them.

use ascii_core::jobs::{Job, JobDone, JobExecutor, Worker};
use std::collections::VecDeque;
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

struct Queue {
    jobs: Mutex<(VecDeque<Job>, bool)>,
    wake: Condvar,
}

pub struct ThreadPool {
    queue: Arc<Queue>,
    results: Receiver<JobDone>,
    workers: usize,
    handles: Vec<std::thread::JoinHandle<()>>,
}

/// Chunk workers: leave a core for the render thread and one for the OS
/// (the webapp does the same, capped at 6).
pub fn default_workers() -> usize {
    if let Some(n) = std::env::var("ASCII_WORKERS").ok().and_then(|v| v.parse::<usize>().ok()) {
        return n.max(1);
    }
    let cores = std::thread::available_parallelism().map_or(4, |n| n.get());
    cores.saturating_sub(2).clamp(1, 6)
}

impl ThreadPool {
    pub fn new(workers: usize) -> Self {
        let queue = Arc::new(Queue { jobs: Mutex::new((VecDeque::new(), false)), wake: Condvar::new() });
        let (tx, results) = channel();
        let handles = (0..workers)
            .map(|i| {
                let q = Arc::clone(&queue);
                let tx = tx.clone();
                std::thread::Builder::new()
                    .name(format!("chunk-{i}"))
                    .stack_size(16 << 20)
                    .spawn(move || {
                        let mut worker = Worker::new();
                        loop {
                            let job = {
                                let mut g = q.jobs.lock().expect("queue lock");
                                loop {
                                    if let Some(j) = g.0.pop_front() {
                                        break j;
                                    }
                                    if g.1 {
                                        return;
                                    }
                                    g = q.wake.wait(g).expect("queue wait");
                                }
                            };
                            let t0 = Instant::now();
                            let output = worker.run(&job.kind);
                            let done = JobDone { id: job.id, elapsed_ms: t0.elapsed().as_secs_f64() * 1000.0, output };
                            if tx.send(done).is_err() {
                                return;
                            }
                        }
                    })
                    .expect("spawn worker")
            })
            .collect();
        ThreadPool { queue, results, workers, handles }
    }
}

impl JobExecutor for ThreadPool {
    fn submit(&mut self, job: Job) {
        self.queue.jobs.lock().expect("queue lock").0.push_back(job);
        self.queue.wake.notify_one();
    }

    fn poll(&mut self, out: &mut Vec<JobDone>) {
        while let Ok(d) = self.results.try_recv() {
            out.push(d);
        }
    }

    fn workers(&self) -> usize {
        self.workers
    }

    fn cancel_queued(&mut self) {
        self.queue.jobs.lock().expect("queue lock").0.clear();
    }
}

impl Drop for ThreadPool {
    fn drop(&mut self) {
        {
            let mut g = self.queue.jobs.lock().expect("queue lock");
            g.0.clear();
            g.1 = true;
        }
        self.queue.wake.notify_all();
        // Workers finish the job in hand; do not block shutdown on long builds.
        self.handles.clear();
    }
}
