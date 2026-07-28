// Isolates ConPTY throughput from the WebView, and pins down PTY shutdown
// semantics.
//
// Finding that motivated the rewrite: reading the master until Ok(0) hangs
// forever. With ConPTY the master does not report EOF when the child exits, it
// reports EOF when the pseudoconsole is closed. So the shutdown order must be:
//   child exits (or is killed) -> drop the master -> reader unblocks.
// Get that wrong and every closed session leaves a parked thread behind.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};

fn main() {
    let megabytes: usize = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(100);

    let path = std::env::temp_dir().join(format!("cockpit_dump_{megabytes}mb.txt"));
    if !path.exists() {
        eprintln!("generating {} ...", path.display());
        let mut line = String::new();
        for i in 0..40 {
            let colour = 31 + (i % 7);
            line.push_str(&format!("\x1b[{colour}m block{i:03} \x1b[0m"));
        }
        line.push('\n');
        let per_mb = 1_048_576 / line.len().max(1);
        let mut f = std::fs::File::create(&path).unwrap();
        for _ in 0..(per_mb * megabytes) {
            f.write_all(line.as_bytes()).unwrap();
        }
    }

    let real = std::fs::metadata(&path).unwrap().len();
    println!("file: {:.1}MB", real as f64 / 1048576.0);

    let pair = NativePtySystem::default()
        .openpty(PtySize {
            rows: 36,
            cols: 106,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();

    let mut cmd = CommandBuilder::new("cmd.exe");
    cmd.arg("/c");
    cmd.arg("type");
    cmd.arg(path.to_string_lossy().to_string());

    let mut child = pair.slave.spawn_command(cmd).unwrap();
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().unwrap();
    let total = Arc::new(AtomicU64::new(0));
    let reads = Arc::new(AtomicU64::new(0));
    let saw_eof = Arc::new(AtomicBool::new(false));

    let t0 = Instant::now();

    let (t2, r2, e2) = (total.clone(), reads.clone(), saw_eof.clone());
    let handle = std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    e2.store(true, Ordering::Relaxed);
                    break;
                }
                Ok(n) => {
                    t2.fetch_add(n as u64, Ordering::Relaxed);
                    r2.fetch_add(1, Ordering::Relaxed);
                }
                Err(_) => {
                    e2.store(true, Ordering::Relaxed);
                    break;
                }
            }
        }
    });

    // The throughput window is spawn -> child exit. Anything after that is
    // shutdown behaviour, measured separately below.
    let _ = child.wait();
    let secs = t0.elapsed().as_secs_f64();
    let bytes = total.load(Ordering::Relaxed);
    let n_reads = reads.load(Ordering::Relaxed).max(1);

    println!(
        "raw conpty: {:.1}MB in {:.1}s = {:.2}MB/s | {} reads (avg {:.0}KB/read)",
        bytes as f64 / 1048576.0,
        secs,
        (bytes as f64 / 1048576.0) / secs,
        n_reads,
        bytes as f64 / n_reads as f64 / 1024.0,
    );

    // Does the reader unblock on its own now that the child is gone? It should not.
    std::thread::sleep(Duration::from_millis(750));
    println!(
        "after child exit, reader saw eof: {}",
        saw_eof.load(Ordering::Relaxed)
    );

    // Now close the pseudoconsole. This is the thing that actually unblocks it.
    let t_close = Instant::now();
    drop(pair.master);
    for _ in 0..40 {
        if saw_eof.load(Ordering::Relaxed) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    println!(
        "after dropping master, reader saw eof: {} (took {:?})",
        saw_eof.load(Ordering::Relaxed),
        t_close.elapsed()
    );

    if saw_eof.load(Ordering::Relaxed) {
        handle.join().unwrap();
        println!("reader thread joined cleanly");
    } else {
        println!("READER THREAD STILL PARKED - would leak per session");
    }
}
