//! The WebAssembly surface of the statevector kernel — specification §5.6,
//! phase 2.
//!
//! ═══════════════════════════════════════════════════════════════════════
//! WHERE THE STATE LIVES, AND WHY IT LIVES THERE
//! ═══════════════════════════════════════════════════════════════════════
//!
//! The statevector is allocated **here, in WebAssembly linear memory**, and
//! JavaScript holds `Float64Array` views onto it. Not the other way round.
//!
//! The alternative — keep the state on the JS heap and copy it in and out
//! around each gate — is not slower at the margin, it is disqualifying.
//! WebAssembly cannot address the JavaScript heap at all, so "pass the
//! statevector" always means "copy it". At 20 qubits the state is 16 MB
//! (2²⁰ amplitudes × 2 arrays × 8 bytes), so a round trip is 32 MB of
//! `memcpy` per gate. The measured TypeScript cost of a whole one-qubit gate
//! at that size is 2.4–5.9 ms; 32 MB of copying is of the same order or
//! worse. A WASM kernel fed that way would lose to the TypeScript it was
//! meant to replace, having done the arithmetic perfectly.
//!
//! So the state crosses the boundary **never**, and what crosses per gate is
//! five integers. `alloc_state` reserves the two arrays contiguously and
//! returns one pointer; JS derives both views from it and hands them to the
//! rest of `@qsim/core` unchanged, because a `Float64Array` over linear
//! memory satisfies the `Statevector` interface exactly like one over the JS
//! heap. Nothing downstream — `probabilities`, `sampleShots`, `blochVectors`,
//! `clone` — needs to know or care.
//!
//! Ownership is explicit and one-directional: this module owns the bytes, the
//! JS session owns the handle, and `free_state` is the only way they are
//! returned. Rust's allocator is what tracks them; there is no GC on this
//! side to do it later.
//!
//! THE HAZARD THAT COMES WITH THAT CHOICE is memory growth. Growing a
//! `WebAssembly.Memory` replaces its `ArrayBuffer` and **detaches every view
//! into it** — existing `Float64Array`s become zero-length, and reads that
//! used to return amplitudes start returning `undefined`. That is a silent
//! wrong answer, which is the one failure mode this project cannot tolerate.
//! Three things hold it off, and they are on the JS side because that is
//! where the views live: the whole state is reserved in one call, so no growth
//! happens mid-circuit; a handle re-derives its views whenever the buffer's
//! identity has changed, so it heals across a growth rather than rotting; and
//! every entry point proves a state is still reachable before touching it,
//! telling "not ours" apart from "detached". See `session.ts`.
//!
//! ═══════════════════════════════════════════════════════════════════════
//! THE ABI
//! ═══════════════════════════════════════════════════════════════════════
//!
//! Every exported function takes and returns numbers only. wasm-bindgen
//! generates no marshalling for those — the emitted JS is a direct call into
//! the instance — so the per-gate boundary cost is a call, not a conversion.
//!
//! A state handle is `(ptr, qubits)`. The real parts occupy `size` doubles at
//! `ptr` and the imaginary parts the `size` doubles immediately after, where
//! `size = 1 << qubits`. One allocation, so one pointer, and the two halves
//! can never be separated by a partial free.
//!
//! Gate matrices are staged through a fixed 32-double scratch buffer
//! (`matrix_ptr`) that is allocated once at init. Writing 8 or 32 doubles
//! into a view is cheaper than 8 or 32 wasm call arguments, and it keeps
//! every signature short enough to read.
//!
//! GUARDS. The TypeScript seam validates every call before it is offered
//! (`kernel.ts` runs the same `check*` functions `apply.ts` runs), but this
//! side does not take that on trust. An out-of-range target here is not a
//! wrong answer, it is a write into somebody else's allocation. So each entry
//! point re-checks its arguments and returns `false` rather than proceeding,
//! and the bridge treats `false` as "declined" and falls back to TypeScript.
//! Rust's own bounds checks are the backstop under that: they trap instead of
//! corrupting, which is the right order of preference but a worse diagnostic.

// EVERY EXPORT TAKES RAW POINTERS AND DEREFERENCES THEM WITHOUT BEING AN
// `unsafe fn`, and clippy is right to notice. Here is why that is the correct
// shape rather than a shortcut.
//
// `unsafe fn` means "the caller promises the preconditions". The caller here is
// JavaScript, which cannot make or keep a Rust safety promise: there is no
// `unsafe` block on the other side, no borrow checker, and no way for the
// compiler to propagate the obligation. Marking these `unsafe fn` would move a
// contract to a party that cannot read it — the safety would be documentation,
// and documentation is not a bounds check.
//
// So the obligation stays here. Every entry point validates the handle, the
// qubit count, the target and the control mask *before* it forms a single
// reference, and returns `false` instead of proceeding — which the bridge
// treats as "declined" and answers by running the TypeScript kernel. The
// remaining precondition, that `ptr` came from `alloc_state` and is still
// live, is held by `session.ts`, which is the only thing that ever produces
// one and makes `release()` idempotent so that it cannot be freed twice.
//
// The lint is disabled for the crate rather than per function because it would
// otherwise be repeated on all ten, which would read as noise rather than as
// the deliberate decision it is.
#![allow(clippy::not_unsafe_ptr_arg_deref)]

mod kernel;

use core::sync::atomic::{AtomicUsize, Ordering};

use kernel::Controls;
use wasm_bindgen::prelude::*;

/// Bumped on any change to the meaning of an exported signature.
///
/// The `.wasm` is a build artifact that outlives the checkout it was built
/// from — it is cached by CI, copied into bundles, and served from a CDN. A
/// loader that instantiated a stale one would get silently wrong arithmetic
/// from a module that instantiated perfectly. The bridge refuses to install a
/// kernel whose version it does not recognise.
pub const KERNEL_ABI_VERSION: u32 = 1;

/// The largest state this module will reserve, mirroring `MAX_QUBITS` in
/// `statevector.ts`.
///
/// wasm32 has a 4 GiB address space, and 2²⁸ amplitudes is 4 GiB on its own,
/// so the practical ceiling here is lower than the engine's: 2²⁷ amplitudes
/// is 2 GiB for the pair of arrays, which is already past what any browser
/// will hand out. The check exists to turn an impossible request into a null
/// return instead of an allocator abort.
const MAX_QUBITS: u32 = 27;

#[wasm_bindgen]
pub fn abi_version() -> u32 {
    KERNEL_ABI_VERSION
}

/// Whether this artifact was compiled with the `simd128` target feature.
///
/// Reported rather than detected: SIMD is a property of the *module*, not of
/// the engine running it, and a module built for `simd128` will not
/// instantiate at all where the proposal is missing. The loader probes the
/// engine separately and picks an artifact; this is how it confirms it got
/// the one it asked for.
#[wasm_bindgen]
pub fn has_simd() -> bool {
    cfg!(feature = "simd")
}

/// Reserve a statevector of `qubits` qubits, initialised to |0…0⟩.
///
/// Returns the base pointer, or null (0) when the size is out of range or the
/// allocator refuses. Null is a normal outcome — the browser is out of memory
/// and the caller falls back to a JS-heap state — not an exception.
#[wasm_bindgen]
pub fn alloc_state(qubits: u32) -> *mut f64 {
    if !(1..=MAX_QUBITS).contains(&qubits) {
        return core::ptr::null_mut();
    }
    let doubles = (1usize << qubits) * 2;

    // `try_reserve_exact` rather than `vec![0.0; n]` so that a browser refusing
    // 2 GiB returns null to the bridge instead of aborting the whole module. An
    // abort here would take the worker down with it, and the fallback path that
    // exists for exactly this case would never run.
    let mut buffer: Vec<f64> = Vec::new();
    if buffer.try_reserve_exact(doubles).is_err() {
        return core::ptr::null_mut();
    }
    buffer.resize(doubles, 0.0);
    buffer[0] = 1.0; // amplitude of |0…0⟩

    // THROUGH A BOXED SLICE, NOT `mem::forget` ON THE VEC. `try_reserve_exact`
    // is allowed to over-allocate, so the capacity is not guaranteed to equal
    // the length — and `free_state` would then have to rebuild the `Vec` with a
    // capacity it cannot know. Deallocating with the wrong layout is undefined
    // behaviour, and the kind that works fine until an allocator change.
    // `into_boxed_slice` shrinks capacity to the length, so the length is the
    // whole layout and `qubits` is enough to reconstruct it.
    Box::into_raw(buffer.into_boxed_slice()) as *mut f64
}

/// Release a statevector. `qubits` must be the value it was allocated with —
/// the allocation is `2 << qubits` doubles and Rust needs the size back to
/// return it.
#[wasm_bindgen]
pub fn free_state(ptr: *mut f64, qubits: u32) {
    if ptr.is_null() || !(1..=MAX_QUBITS).contains(&qubits) {
        return;
    }
    let doubles = (1usize << qubits) * 2;
    // SAFETY: `ptr` is non-null and `qubits` is in range, so this reconstructs
    // exactly the boxed slice `alloc_state` leaked. Passing a pointer this
    // module did not hand out, or freeing twice, is the one thing the JS side
    // must not do — `session.ts` owns that by making `release()` idempotent
    // and unregistering the handle before it calls here.
    unsafe {
        drop(Box::from_raw(core::ptr::slice_from_raw_parts_mut(
            ptr, doubles,
        )));
    }
}

/// Where the matrix staging buffer lives, or 0 before it is first requested.
///
/// An `AtomicUsize` rather than a `static mut`: taking a reference to a mutable
/// static is a lint in edition 2021 and an error in 2024, and the atomic says
/// what is actually meant — one slot, written once, read on every gate. There
/// is no contention to pay for here because WebAssembly linear memory belongs
/// to one thread (see `session.ts` on why the accelerator lives inside the
/// worker that already owns the simulation).
static MATRIX_SCRATCH: AtomicUsize = AtomicUsize::new(0);

/// The staging buffer gate matrices are written into: 32 doubles, enough for
/// a 4×4. Allocated once on first use and never freed — it is 256 bytes, and
/// a per-gate allocation is exactly what this module exists to avoid.
#[wasm_bindgen]
pub fn matrix_ptr() -> *mut f64 {
    let existing = MATRIX_SCRATCH.load(Ordering::Relaxed);
    if existing != 0 {
        return existing as *mut f64;
    }
    let buffer = vec![0f64; 32].into_boxed_slice();
    let ptr = Box::into_raw(buffer) as *mut f64;
    MATRIX_SCRATCH.store(ptr as usize, Ordering::Relaxed);
    ptr
}

/// Split a state handle into its real and imaginary halves.
unsafe fn halves<'a>(ptr: *mut f64, size: usize) -> (&'a mut [f64], &'a mut [f64]) {
    (
        core::slice::from_raw_parts_mut(ptr, size),
        core::slice::from_raw_parts_mut(ptr.add(size), size),
    )
}

/// The arguments every gate shares, checked once. Returns the state size, or
/// `None` when the handle or the qubit count is not usable.
fn check(ptr: *const f64, qubits: u32) -> Option<usize> {
    if ptr.is_null() || !(1..=MAX_QUBITS).contains(&qubits) {
        return None;
    }
    Some(1usize << qubits)
}

/// A control mask is valid when it names only real qubits and `value` selects
/// only bits the mask examines. A `value` bit outside the mask would make the
/// condition unsatisfiable and the gate would silently never fire.
fn check_controls(qubits: u32, mask: u32, value: u32) -> Option<Controls> {
    let all = if qubits >= 32 { u32::MAX } else { (1u32 << qubits) - 1 };
    if mask & !all != 0 || value & !mask != 0 {
        return None;
    }
    Some(Controls {
        mask: mask as usize,
        value: value as usize,
    })
}

/// Apply the 2×2 currently staged at `matrix_ptr()` to `target`, under the
/// control condition `(index & mask) == value`.
///
/// `mask == 0` is the uncontrolled gate. Returns `false` without touching the
/// state when any argument is out of range.
#[wasm_bindgen]
pub fn apply_controlled(
    ptr: *mut f64,
    qubits: u32,
    target: u32,
    mask: u32,
    value: u32,
) -> bool {
    let Some(size) = check(ptr, qubits) else {
        return false;
    };
    if target >= qubits {
        return false;
    }
    let Some(controls) = check_controls(qubits, mask, value) else {
        return false;
    };
    // A control on the target would have to fire and not fire at once.
    if mask & (1u32 << target) != 0 {
        return false;
    }
    let scratch = matrix_ptr();
    if scratch.is_null() {
        return false;
    }
    // SAFETY: `size` came from `check`, so both halves lie inside the
    // allocation `alloc_state` made; the scratch buffer is 32 doubles and a
    // 2×2 reads the first 8; and the state and the scratch are separate
    // allocations, so the shared borrow of one cannot alias the mutable
    // borrows of the other.
    unsafe {
        let matrix = &*(scratch as *const [f64; 8]);
        let (re, im) = halves(ptr, size);
        kernel::apply_controlled(re, im, matrix, target, controls);
    }
    true
}

/// Exchange `q0` and `q1` where the controls admit. `mask == 0` is a plain
/// SWAP; one control bit is `cswap`.
#[wasm_bindgen]
pub fn apply_swap(
    ptr: *mut f64,
    qubits: u32,
    q0: u32,
    q1: u32,
    mask: u32,
    value: u32,
) -> bool {
    let Some(size) = check(ptr, qubits) else {
        return false;
    };
    if q0 >= qubits || q1 >= qubits || q0 == q1 {
        return false;
    }
    let Some(controls) = check_controls(qubits, mask, value) else {
        return false;
    };
    if mask & ((1u32 << q0) | (1u32 << q1)) != 0 {
        return false;
    }
    // SAFETY: `size` came from `check`, so both halves lie inside the
    // allocation `alloc_state` made.
    unsafe {
        let (re, im) = halves(ptr, size);
        kernel::apply_swap(re, im, q0, q1, controls);
    }
    true
}

/// iSWAP on `(q0, q1)`. No controls — the contract has no controlled iSWAP.
#[wasm_bindgen]
pub fn apply_iswap(ptr: *mut f64, qubits: u32, q0: u32, q1: u32) -> bool {
    let Some(size) = check(ptr, qubits) else {
        return false;
    };
    if q0 >= qubits || q1 >= qubits || q0 == q1 {
        return false;
    }
    // SAFETY: `size` came from `check`, so both halves lie inside the
    // allocation `alloc_state` made.
    unsafe {
        let (re, im) = halves(ptr, size);
        kernel::apply_iswap(re, im, q0, q1);
    }
    true
}

/// Apply the 4×4 currently staged at `matrix_ptr()` to `(q0, q1)`.
#[wasm_bindgen]
pub fn apply_2q(ptr: *mut f64, qubits: u32, q0: u32, q1: u32) -> bool {
    let Some(size) = check(ptr, qubits) else {
        return false;
    };
    if q0 >= qubits || q1 >= qubits || q0 == q1 {
        return false;
    }
    let scratch = matrix_ptr();
    if scratch.is_null() {
        return false;
    }
    // SAFETY: as `apply_controlled`, with the scratch buffer read in full —
    // it is exactly the 32 doubles a 4×4 needs.
    unsafe {
        let matrix = &*(scratch as *const [f64; 32]);
        let (re, im) = halves(ptr, size);
        kernel::apply_2q(re, im, matrix, q0, q1);
    }
    true
}

/// Σ|aᵢ|². Returns a negative number for an invalid handle, which no real
/// squared norm can be.
#[wasm_bindgen]
pub fn norm_squared(ptr: *const f64, qubits: u32) -> f64 {
    let Some(size) = check(ptr, qubits) else {
        return -1.0;
    };
    // SAFETY: `size` came from `check`, so both halves lie inside the
    // allocation `alloc_state` made. Read-only.
    unsafe {
        let re = core::slice::from_raw_parts(ptr, size);
        let im = core::slice::from_raw_parts(ptr.add(size), size);
        kernel::norm_squared(re, im)
    }
}

/// Multiply every amplitude by `factor`.
#[wasm_bindgen]
pub fn scale(ptr: *mut f64, qubits: u32, factor: f64) -> bool {
    let Some(size) = check(ptr, qubits) else {
        return false;
    };
    // SAFETY: `size` came from `check`, so both halves lie inside the
    // allocation `alloc_state` made.
    unsafe {
        let (re, im) = halves(ptr, size);
        kernel::scale(re, im, factor);
    }
    true
}

/// Write `|aᵢ|²` for every `i` into the `size` doubles at `out`.
#[wasm_bindgen]
pub fn probabilities(ptr: *const f64, qubits: u32, out: *mut f64) -> bool {
    let Some(size) = check(ptr, qubits) else {
        return false;
    };
    if out.is_null() {
        return false;
    }
    // SAFETY: `size` came from `check`, and `out` is a non-null pointer into
    // the same linear memory with room for `size` doubles — the bridge checks
    // that in `createExtras`, which refuses a JS-heap output buffer outright
    // because it has no address this side could write through.
    unsafe {
        let re = core::slice::from_raw_parts(ptr, size);
        let im = core::slice::from_raw_parts(ptr.add(size), size);
        let target = core::slice::from_raw_parts_mut(out, size);
        kernel::probabilities(re, im, target);
    }
    true
}

/// The reduced density matrix of `qubit`, written into the four doubles at
/// `out` as `[rho00, rho11, re01, im01]`.
///
/// Four numbers come back through memory rather than as a returned array
/// because wasm-bindgen would allocate a JS array for the latter, on a call
/// the analysis panel makes once per qubit per edit.
#[wasm_bindgen]
pub fn reduced_density(
    ptr: *const f64,
    qubits: u32,
    qubit: u32,
    out: *mut f64,
) -> bool {
    let Some(size) = check(ptr, qubits) else {
        return false;
    };
    if qubit >= qubits || out.is_null() {
        return false;
    }
    // SAFETY: `size` came from `check`; `out` is non-null with room for four
    // doubles (the bridge points it at the tail of the 32-double staging
    // buffer); and `result` is a local array, so the copy cannot overlap it.
    unsafe {
        let re = core::slice::from_raw_parts(ptr, size);
        let im = core::slice::from_raw_parts(ptr.add(size), size);
        let result = kernel::reduced_density(re, im, qubit);
        core::ptr::copy_nonoverlapping(result.as_ptr(), out, 4);
    }
    true
}
