//! The numeric core: index-pairing gate application over a statevector held
//! in linear memory.
//!
//! This module is a **transliteration of `packages/qsim/src/apply.ts`**, not a
//! reimplementation of it. That distinction is the whole design:
//!
//!  - The loop structure is the same — `base`/`offset` counters over the
//!    stride of the target bit, derived in the header of `apply.ts`.
//!  - The arithmetic is written with the *same association and the same
//!    order* as the TypeScript, down to the parentheses. Rust performs no
//!    floating-point contraction or reassociation without being asked (there
//!    is no `-ffast-math` here and `f64` ops are IEEE-754), so the two sides
//!    do not merely agree to a tolerance — they produce identical bits. The
//!    1e-12 the equivalence suite asserts is the contract; equality is what
//!    actually happens, and a failure at 1e-16 is already a real defect.
//!  - Where `apply.ts` specialises, this specialises identically. SWAP is an
//!    exchange of two amplitudes rather than a 4×4 multiply, because a
//!    permutation dressed as arithmetic would be four times the memory
//!    traffic on both sides and would also break bit-equality with the
//!    reference by summing zero terms.
//!
//! Nothing in here mentions WebAssembly. It is plain Rust over `&mut [f64]`,
//! which is what lets `cargo test` exercise it natively on the host — see the
//! `rlib` note in Cargo.toml.
//!
//! ENDIANNESS (decision D1). Amplitude index `i` has qubit `q` in bit `q`, so
//! qubit 0 is the least significant bit. Every `1 << q` below is that decision
//! and nothing else. This is the third place in the project the convention is
//! written down and the least forgiving: a transposed convention here produces
//! a perfectly normalised state with its qubits mirrored, which no norm check
//! and no unitarity check would notice.

/// A control condition folded into two integers, exactly as `apply.ts` folds
/// it: `mask` is the bits examined, `value` is what they must equal. Negative
/// controls are the bits in `mask` and not in `value`, for free.
///
/// `mask == 0` means unconditional — the `apply1q` case — and is branched on
/// once per gate rather than tested 2ⁿ⁻¹ times.
#[derive(Clone, Copy)]
pub struct Controls {
    pub mask: usize,
    pub value: usize,
}

impl Controls {
    /// The unconditional case, spelled out, for the tests below.
    ///
    /// Gated because `kernel` is a private module (`mod kernel;` in lib.rs),
    /// so `pub` does not make this reachable from outside the crate and every
    /// caller is in `mod tests`. Without the gate `-D warnings` fails the
    /// build on `dead_code`, and it is right to: in a non-test build this
    /// really is unused. The one production path that needs a `Controls`
    /// builds it directly from the mask it was given — see `check_controls`,
    /// where `mask == 0` arrives as data rather than as a named case.
    #[cfg(test)]
    #[inline(always)]
    pub fn none() -> Self {
        Controls { mask: 0, value: 0 }
    }

    #[inline(always)]
    fn admits(&self, index: usize) -> bool {
        index & self.mask == self.value
    }
}

/// Apply a 2×2 to `target`, on the indices the controls admit.
///
/// The eight matrix entries are copied into locals before the loop for the
/// same reason `apply.ts` does it: inside, they are used 2ⁿ⁻¹ times, and a
/// bounds-checked slice load per use would dominate the multiplies.
///
/// The unconditional case gets its own loop instead of running with
/// `mask == 0`. It is not about the `&` — it is that the branch inside the
/// inner loop blocks vectorisation of the common gate in the product.
pub fn apply_controlled(
    re: &mut [f64],
    im: &mut [f64],
    matrix: &[f64; 8],
    target: u32,
    controls: Controls,
) {
    let size = re.len();
    let m00r = matrix[0];
    let m00i = matrix[1];
    let m01r = matrix[2];
    let m01i = matrix[3];
    let m10r = matrix[4];
    let m10i = matrix[5];
    let m11r = matrix[6];
    let m11i = matrix[7];

    let stride = 1usize << target;

    // One closure, used by both loops, so the two paths cannot drift in the
    // arithmetic while differing only in which indices they visit.
    let mut pair = |i0: usize, i1: usize| {
        let a0r = re[i0];
        let a0i = im[i0];
        let a1r = re[i1];
        let a1i = im[i1];
        re[i0] = m00r * a0r - m00i * a0i + (m01r * a1r - m01i * a1i);
        im[i0] = m00r * a0i + m00i * a0r + (m01r * a1i + m01i * a1r);
        re[i1] = m10r * a0r - m10i * a0i + (m11r * a1r - m11i * a1i);
        im[i1] = m10r * a0i + m10i * a0r + (m11r * a1i + m11i * a1r);
    };

    if controls.mask == 0 {
        let mut base = 0usize;
        while base < size {
            for offset in 0..stride {
                let i0 = base + offset;
                pair(i0, i0 + stride);
            }
            base += stride << 1;
        }
    } else {
        let mut base = 0usize;
        while base < size {
            for offset in 0..stride {
                let i0 = base + offset;
                // Testing i0 alone is enough: i0 and i1 differ only in the
                // target bit, and a control may not be the target — the
                // TypeScript guard in `apply.ts` has already rejected that.
                if controls.admits(i0) {
                    pair(i0, i0 + stride);
                }
            }
            base += stride << 1;
        }
    }
}

/// Exchange the `|01⟩` and `|10⟩` amplitudes of the pair `(q0, q1)`, on the
/// indices the controls admit. `cswap` is this with one control.
///
/// `|00⟩` and `|11⟩` are already symmetric under the exchange, so three
/// quarters of the state is not read at all.
pub fn apply_swap(re: &mut [f64], im: &mut [f64], q0: u32, q1: u32, controls: Controls) {
    let size = re.len();
    let bit0 = 1usize << q0;
    let bit1 = 1usize << q1;
    let lower = bit0.min(bit1);
    let upper = bit0.max(bit1);

    let mut upper_base = 0usize;
    while upper_base < size {
        let mut middle = 0usize;
        while middle < upper {
            for offset in 0..lower {
                let base = upper_base + middle + offset;
                if !controls.admits(base) {
                    continue;
                }
                let i01 = base + bit0;
                let i10 = base + bit1;
                re.swap(i01, i10);
                im.swap(i01, i10);
            }
            middle += lower << 1;
        }
        upper_base += upper << 1;
    }
}

/// iSWAP: exchange `q0` and `q1` and multiply the exchanged amplitudes by `i`.
///
/// Multiplying by `i` is `(x, y) → (-y, x)`, so like SWAP this is bookkeeping
/// and not arithmetic — no rounding happens, which is why it agrees with the
/// reference exactly rather than nearly.
///
/// No controls: the contract has no controlled iSWAP, and a parameter for one
/// here would suggest the editor can produce it.
pub fn apply_iswap(re: &mut [f64], im: &mut [f64], q0: u32, q1: u32) {
    let size = re.len();
    let bit0 = 1usize << q0;
    let bit1 = 1usize << q1;
    let lower = bit0.min(bit1);
    let upper = bit0.max(bit1);

    let mut upper_base = 0usize;
    while upper_base < size {
        let mut middle = 0usize;
        while middle < upper {
            for offset in 0..lower {
                let base = upper_base + middle + offset;
                let i01 = base + bit0;
                let i10 = base + bit1;
                let a01r = re[i01];
                let a01i = im[i01];
                let a10r = re[i10];
                let a10i = im[i10];
                // new a₀₁ = i·a₁₀ and new a₁₀ = i·a₀₁.
                re[i01] = -a10i;
                im[i01] = a10r;
                re[i10] = -a01i;
                im[i10] = a01r;
            }
            middle += lower << 1;
        }
        upper_base += upper << 1;
    }
}

/// An arbitrary 4×4 on the pair `(q0, q1)`. Row and column index is
/// `2·b₁ + b₀`, where b₀ is the bit of the **first** qubit argument — the
/// local echo of D1, as in `apply.ts`.
///
/// The row/column loop is kept rather than unrolled into sixteen complex
/// products, matching the reference: every two-qubit gate in the contract has
/// a specialised path, so this is the escape hatch for custom unitaries. The
/// profile has it at 12.9 ms against 1.4 ms for the specialised SWAP at 20
/// qubits, which is the cost of generality and the reason it is not the road
/// the runner takes.
// The index in the inner loops addresses four separate fixed-size arrays at
// once — `index`, `in_r`, `in_i`, `out_r`, `out_i` — so an iterator would need
// a five-way zip to say what `for k in 0..4` says plainly. This is the one
// place the lint is wrong about the code.
#[allow(clippy::needless_range_loop)]
pub fn apply_2q(re: &mut [f64], im: &mut [f64], matrix: &[f64; 32], q0: u32, q1: u32) {
    let size = re.len();
    let bit0 = 1usize << q0;
    let bit1 = 1usize << q1;
    let lower = bit0.min(bit1);
    let upper = bit0.max(bit1);

    let mut index = [0usize; 4];
    let mut in_r = [0f64; 4];
    let mut in_i = [0f64; 4];
    let mut out_r = [0f64; 4];
    let mut out_i = [0f64; 4];

    let mut upper_base = 0usize;
    while upper_base < size {
        let mut middle = 0usize;
        while middle < upper {
            for offset in 0..lower {
                let base = upper_base + middle + offset;
                index[0] = base;
                index[1] = base + bit0;
                index[2] = base + bit1;
                index[3] = base + bit0 + bit1;

                for k in 0..4 {
                    in_r[k] = re[index[k]];
                    in_i[k] = im[index[k]];
                }
                for row in 0..4 {
                    let mut sum_r = 0f64;
                    let mut sum_i = 0f64;
                    for column in 0..4 {
                        let at = (row * 4 + column) * 2;
                        let mr = matrix[at];
                        let mi = matrix[at + 1];
                        sum_r += mr * in_r[column] - mi * in_i[column];
                        sum_i += mr * in_i[column] + mi * in_r[column];
                    }
                    out_r[row] = sum_r;
                    out_i[row] = sum_i;
                }
                for k in 0..4 {
                    re[index[k]] = out_r[k];
                    im[index[k]] = out_i[k];
                }
            }
            middle += lower << 1;
        }
        upper_base += upper << 1;
    }
}

/// Σ|aᵢ|², the squared norm. The caller takes the square root, so this stays
/// one pass and one instruction sequence.
///
/// The accumulation is strictly sequential. Summing 2ⁿ doubles in a different
/// order gives a different last bit, and a norm that disagreed with the
/// reference in the last bit would move the renormalisation scale and, from
/// there, every amplitude — turning a bit-exact kernel into an approximate
/// one for no gain. LLVM will not reassociate a floating-point reduction
/// without fast-math, so this is what ships even with `simd` enabled, and it
/// is the one function in the file SIMD does not help.
pub fn norm_squared(re: &[f64], im: &[f64]) -> f64 {
    let mut sum = 0f64;
    // `zip` rather than an index: the two arrays are walked in lockstep, and
    // this drops a bounds check per amplitude without changing the order in
    // which the terms are added — which is the property that has to hold.
    for (r, i) in re.iter().zip(im.iter()) {
        sum += r * r + i * i;
    }
    sum
}

/// Multiply every amplitude by `scale`.
///
/// Takes the scale rather than computing it, so that the reciprocal is formed
/// once by the caller in the same way `statevector.ts` forms it — one division
/// and 2ⁿ multiplications, not 2ⁿ divisions.
pub fn scale(re: &mut [f64], im: &mut [f64], scale: f64) {
    for (r, i) in re.iter_mut().zip(im.iter_mut()) {
        *r *= scale;
        *i *= scale;
    }
}

/// Born rule: `out[i] = |aᵢ|²`. `out` must be `size` long.
pub fn probabilities(re: &[f64], im: &[f64], out: &mut [f64]) {
    for ((o, r), i) in out.iter_mut().zip(re.iter()).zip(im.iter()) {
        *o = r * r + i * i;
    }
}

/// The reduced density matrix of one qubit — `[rho00, rho11, re01, im01]`,
/// the four numbers §5.5's Bloch vector is built from.
///
/// Same walk as a gate: each index is visited once as a member of one pair, so
/// it is a single pass whatever the qubit. Included because the profile puts
/// `blochVectors` at 34.9 ms for a 20-qubit state — the largest single cost on
/// the live analysis panel, above every individual gate — and it is n of these
/// summed, one per qubit.
pub fn reduced_density(re: &[f64], im: &[f64], qubit: u32) -> [f64; 4] {
    let size = re.len();
    let stride = 1usize << qubit;

    let mut rho00 = 0f64;
    let mut rho11 = 0f64;
    let mut re01 = 0f64;
    let mut im01 = 0f64;

    let mut base = 0usize;
    while base < size {
        for offset in 0..stride {
            let zero = base + offset;
            let one = zero + stride;
            let zr = re[zero];
            let zi = im[zero];
            let or = re[one];
            let oi = im[one];

            rho00 += zr * zr + zi * zi;
            rho11 += or * or + oi * oi;
            // ρ₀₁ = Σ ψ₀ · conj(ψ₁), over every configuration of the rest.
            re01 += zr * or + zi * oi;
            im01 += zi * or - zr * oi;
        }
        base += stride << 1;
    }

    [rho00, rho11, re01, im01]
}

#[cfg(test)]
mod tests {
    use super::*;

    const SQRT1_2: f64 = std::f64::consts::FRAC_1_SQRT_2;

    fn h() -> [f64; 8] {
        [SQRT1_2, 0.0, SQRT1_2, 0.0, SQRT1_2, 0.0, -SQRT1_2, 0.0]
    }

    fn x() -> [f64; 8] {
        [0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 0.0]
    }

    fn ground(qubits: u32) -> (Vec<f64>, Vec<f64>) {
        let size = 1usize << qubits;
        let mut re = vec![0.0; size];
        re[0] = 1.0;
        (re, vec![0.0; size])
    }

    /// A Bell pair: H on qubit 0, then X on qubit 1 controlled by qubit 0.
    /// Amplitudes 0 and 3 hold 1/√2 — the canonical check that the index
    /// pairing and the control mask agree with D1.
    #[test]
    fn builds_a_bell_pair() {
        let (mut re, mut im) = ground(2);
        apply_controlled(&mut re, &mut im, &h(), 0, Controls::none());
        apply_controlled(&mut re, &mut im, &x(), 1, Controls { mask: 1, value: 1 });

        assert!((re[0] - SQRT1_2).abs() < 1e-15);
        assert!(re[1].abs() < 1e-15);
        assert!(re[2].abs() < 1e-15);
        assert!((re[3] - SQRT1_2).abs() < 1e-15);
        assert!((norm_squared(&re, &im) - 1.0).abs() < 1e-15);
    }

    /// A negative control is `mask` without `value`: the gate fires where the
    /// control reads 0. Starting from |00⟩ the control is satisfied, so this
    /// must move amplitude 0 to amplitude 2.
    #[test]
    fn negative_control_fires_on_zero() {
        let (mut re, mut im) = ground(2);
        apply_controlled(&mut re, &mut im, &x(), 1, Controls { mask: 1, value: 0 });
        assert!(re[0].abs() < 1e-15);
        assert!((re[2] - 1.0).abs() < 1e-15);
    }

    /// D1 in one assertion: X on qubit 0 of a 3-qubit state moves |000⟩ to
    /// index 1, not to index 4. Index 4 would be the big-endian answer.
    #[test]
    fn qubit_zero_is_the_least_significant_bit() {
        let (mut re, mut im) = ground(3);
        apply_controlled(&mut re, &mut im, &x(), 0, Controls::none());
        assert!((re[1] - 1.0).abs() < 1e-15);
        assert!(re[4].abs() < 1e-15);
    }

    /// SWAP through the specialised path and through the generic 4×4 must
    /// produce the same state — the specialisation is an optimisation of the
    /// matrix, so this is what says it stayed one.
    #[test]
    fn swap_matches_the_generic_four_by_four() {
        let (mut a_re, mut a_im) = ground(3);
        apply_controlled(&mut a_re, &mut a_im, &h(), 0, Controls::none());
        let (mut b_re, mut b_im) = (a_re.clone(), a_im.clone());

        apply_swap(&mut a_re, &mut a_im, 0, 2, Controls::none());

        // Entry (r, c) sits at `(4r + c) * 2`. SWAP is 1 at (0,0), (1,2),
        // (2,1) and (3,3) — the |01⟩ and |10⟩ rows exchanged.
        let mut swap4 = [0f64; 32];
        swap4[0] = 1.0; // (0,0)
        swap4[12] = 1.0; // (1,2)
        swap4[18] = 1.0; // (2,1)
        swap4[30] = 1.0; // (3,3)
        apply_2q(&mut b_re, &mut b_im, &swap4, 0, 2);

        for ((ar, br), (ai, bi)) in a_re
            .iter()
            .zip(b_re.iter())
            .zip(a_im.iter().zip(b_im.iter()))
        {
            assert!((ar - br).abs() < 1e-15);
            assert!((ai - bi).abs() < 1e-15);
        }
    }

    /// iSWAP applied twice is SWAP times i on the exchanged amplitudes; the
    /// cheap invariant is that it preserves the norm exactly.
    #[test]
    fn iswap_preserves_the_norm() {
        let (mut re, mut im) = ground(3);
        apply_controlled(&mut re, &mut im, &h(), 0, Controls::none());
        apply_controlled(&mut re, &mut im, &h(), 1, Controls::none());
        apply_iswap(&mut re, &mut im, 0, 1);
        assert!((norm_squared(&re, &im) - 1.0).abs() < 1e-15);
    }

    /// Each half of a Bell pair is maximally mixed: ρ₀₀ = ρ₁₁ = ½ and the
    /// off-diagonal vanishes, so the Bloch vector sits at the centre. This is
    /// the §5.5 result the analysis panel draws.
    #[test]
    fn bell_halves_are_maximally_mixed() {
        let (mut re, mut im) = ground(2);
        apply_controlled(&mut re, &mut im, &h(), 0, Controls::none());
        apply_controlled(&mut re, &mut im, &x(), 1, Controls { mask: 1, value: 1 });

        for qubit in 0..2 {
            let [rho00, rho11, re01, im01] = reduced_density(&re, &im, qubit);
            assert!((rho00 - 0.5).abs() < 1e-15);
            assert!((rho11 - 0.5).abs() < 1e-15);
            assert!(re01.abs() < 1e-15);
            assert!(im01.abs() < 1e-15);
        }
    }

    /// Every index is visited exactly once by the pairing walk, at every
    /// target. Applying X to qubit `t` is a permutation, so the multiset of
    /// amplitudes must be preserved and every one must have moved to the index
    /// with bit `t` flipped.
    #[test]
    fn the_walk_covers_every_index_at_every_target() {
        for qubits in 1..=6u32 {
            let size = 1usize << qubits;
            for target in 0..qubits {
                let mut re: Vec<f64> = (0..size).map(|i| i as f64).collect();
                let mut im = vec![0.0; size];
                apply_controlled(&mut re, &mut im, &x(), target, Controls::none());
                for (i, value) in re.iter().enumerate() {
                    let partner = i ^ (1usize << target);
                    assert_eq!(*value, partner as f64, "qubits {qubits}, target {target}");
                }
            }
        }
    }
}
