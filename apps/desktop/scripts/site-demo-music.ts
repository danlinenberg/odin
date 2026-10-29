/**
 * The trailer's score (site/trailer.html), synthesized here so there is no
 * track to license. 120 BPM in A minor: an impact on each word of the hook, a
 * riser into the groove, the groove under every scene, its drums dropped for
 * the night, and a held chord for the close. The hits sit on the trailer's own
 * moments - the clicks, the pings, the cuts - which it publishes as
 * window.MOMENTS, so the score follows any change to the timeline.
 *
 * musicWav(moments) is a 16-bit stereo WAV; site-demo.ts muxes it in.
 */

const RATE = 44_100;
const BEAT = 0.5;

/** The trailer's moments, from window.MOMENTS in site/trailer.html. */
export type Moments = {
	duration: number;
	hookWords: number[];
	hookAnswer: number;
	/** The groove starts here and runs to the close. */
	grooveFrom: number;
	/** Scene cuts: a whoosh into each. */
	cuts: number[];
	/** No drums in here: the night. */
	quiet: [number, number];
	pings: number[];
	clicks: number[];
	/** Things flying across: sessions to the host. */
	whooshes: number[];
	/** Small ticks: typing, the night's clock. */
	ticks: number[];
	chips: number[];
	close: number;
};

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
// Am, F, C, G - a bar each.
const CHORDS = [
	[57, 60, 64, 71],
	[53, 57, 60, 67],
	[48, 55, 64, 67],
	[55, 59, 62, 69],
];

/** A deterministic noise source, so every render sounds the same. */
function noise(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return ((s >>> 0) / 4_294_967_296) * 2 - 1;
	};
}

export function musicWav(m: Moments): Buffer {
	const { duration, grooveFrom, close } = m;
	const n = Math.ceil(duration * RATE);
	const left = new Float32Array(n);
	const right = new Float32Array(n);
	const add = (i: number, v: number, pan = 0) => {
		if (i < 0 || i >= n) return;
		left[i] = (left[i] ?? 0) + v * (1 - pan) * Math.SQRT1_2;
		right[i] = (right[i] ?? 0) + v * (1 + pan) * Math.SQRT1_2;
	};
	const at = (t: number) => Math.round(t * RATE);
	const quiet = (t: number) => t >= m.quiet[0] && t < m.quiet[1];
	const chord = (t: number) =>
		CHORDS[Math.floor(Math.max(0, t - grooveFrom) / (BEAT * 4)) % 4] ?? [];
	const rnd = noise(7);

	// Kick: a sine falling from 150 Hz, on every beat (every other one at night).
	const kicks: number[] = [];
	for (let t = grooveFrom; t < close; t += BEAT) {
		const beat = Math.round((t - grooveFrom) / BEAT);
		if (quiet(t) && beat % 2) continue;
		kicks.push(t);
		const gain = quiet(t) ? 0.35 : 0.8;
		let phase = 0;
		for (let k = 0; k < 0.4 * RATE; k++) {
			const s = k / RATE;
			phase += (2 * Math.PI * (45 + 105 * Math.exp(-s / 0.03))) / RATE;
			add(at(t) + k, gain * Math.sin(phase) * Math.exp(-s / 0.12));
		}
	}
	// Everything tonal ducks under the kick.
	const duck = new Float32Array(n).fill(1);
	for (const t of kicks)
		for (let k = 0; k < 0.25 * RATE; k++) {
			const i = at(t) + k;
			if (i < n)
				duck[i] = Math.min(duck[i] ?? 1, 1 - 0.6 * Math.exp(-k / RATE / 0.08));
		}

	// Hats on the off-beats, a clap on 2 and 4; none at night.
	for (let t = grooveFrom + BEAT / 2; t < close; t += BEAT) {
		if (quiet(t)) continue;
		let last = 0;
		for (let k = 0; k < 0.06 * RATE; k++) {
			const x = rnd();
			add(at(t) + k, 0.11 * (x - last) * Math.exp(-k / RATE / 0.02), 0.3);
			last = x;
		}
	}
	for (let t = grooveFrom + BEAT; t < close; t += 2 * BEAT) {
		if (quiet(t)) continue;
		let lp = 0;
		for (let k = 0; k < 0.2 * RATE; k++) {
			const x = rnd();
			lp += 0.35 * (x - lp);
			add(at(t) + k, 0.28 * (x - lp) * Math.exp(-k / RATE / 0.06), -0.1);
		}
	}

	// Bass: a filtered saw on the chord's root, in eighths.
	for (let t = grooveFrom; t < close; t += BEAT / 2) {
		const f = hz((chord(t)[0] ?? 57) - 24);
		const gain = quiet(t) ? 0.12 : 0.2;
		let lp = 0;
		for (let k = 0; k < (BEAT / 2) * RATE; k++) {
			const saw = 2 * ((k * f) / RATE - Math.floor((k * f) / RATE + 0.5));
			lp += 0.08 * (saw - lp);
			const i = at(t) + k;
			add(i, gain * lp * Math.exp(-k / RATE / 0.18) * (duck[i] ?? 1));
		}
	}

	// Pads: three detuned saws per chord note, low-passed, slow in and out.
	let padLp = 0;
	for (let i = 0; i < n; i++) {
		const t = i / RATE;
		const notes =
			t < grooveFrom
				? [45, 52, 57, 64]
				: t >= close
					? [45, 57, 60, 64, 71]
					: chord(t);
		const swell = Math.min(1, t / 1.5) * Math.min(1, (duration - t) / 2.5);
		const gain = (t >= close ? 0.06 : quiet(t) ? 0.05 : 0.035) * swell;
		let v = 0;
		for (const [j, note] of notes.entries())
			for (const d of [-0.12, 0, 0.12]) {
				const f = hz(note + d) * (1 + j * 1e-4);
				v += 2 * ((t * f) % 1) - 1;
			}
		padLp += 0.12 * (v / 6 - padLp);
		add(i, gain * padLp * (duck[i] ?? 1), Math.sin(t * 0.7) * 0.3);
	}

	// Arpeggio: chord tones an octave up, in sixteenths (eighths at night).
	for (let t = grooveFrom; t < close; t += BEAT / 4) {
		const step = Math.round((t - grooveFrom) / (BEAT / 4));
		if (quiet(t) && step % 2) continue;
		const notes = chord(t);
		const f = hz((notes[step % notes.length] ?? 69) + 12);
		for (let k = 0; k < 0.18 * RATE; k++) {
			const s = k / RATE;
			const tone =
				Math.sin(2 * Math.PI * f * s) + 0.3 * Math.sin(4 * Math.PI * f * s);
			add(
				at(t) + k,
				(quiet(t) ? 0.035 : 0.05) * tone * Math.exp(-s / 0.07),
				step % 2 ? 0.4 : -0.4,
			);
		}
	}

	// Impacts: a sub boom and a dark burst. Small for each hook word, big for the close.
	const impact = (t: number, gain: number, length: number) => {
		let lp = 0;
		for (let k = 0; k < length * RATE; k++) {
			const s = k / RATE;
			lp += 0.05 * (rnd() - lp);
			const boom =
				Math.sin(2 * Math.PI * (40 + 30 * Math.exp(-s / 0.05)) * s) *
				Math.exp(-s / (length / 3));
			add(at(t) + k, gain * (boom + 2.5 * lp * Math.exp(-s / 0.15)));
		}
	};
	for (const t of m.hookWords) impact(t, 0.45, 0.8);
	impact(m.hookAnswer, 0.6, 1.4);
	impact(close, 0.9, 3.5);

	// Risers into the groove and into the close, whooshes into the cuts and
	// under whatever flies across.
	const sweep = (from: number, to: number, gain: number) => {
		let lp = 0;
		for (let k = 0; k < (to - from) * RATE; k++) {
			const p = k / ((to - from) * RATE);
			lp += (0.02 + 0.5 * p * p) * (rnd() - lp);
			add(at(from) + k, gain * p * p * lp, Math.sin(p * 6) * 0.5);
		}
	};
	sweep(grooveFrom - 1.1, grooveFrom, 0.6);
	sweep(close - 1.1, close, 0.7);
	for (const t of m.cuts) sweep(t - 0.45, t, 0.35);
	for (const t of m.whooshes) sweep(t, t + 0.35, 0.18);

	// Pings: a bell each, stepping up. Clicks, ticks and the wall's chips: blips.
	for (const [j, ping] of m.pings.entries()) {
		const f = [1760, 1976, 2349][j % 3] ?? 1760;
		for (let k = 0; k < 1.4 * RATE; k++) {
			const s = k / RATE;
			const bell =
				Math.sin(2 * Math.PI * f * s) +
				0.5 * Math.sin(2 * Math.PI * f * 1.5 * s) +
				0.25 * Math.sin(2 * Math.PI * f * 2 * s);
			add(at(ping) + k, 0.14 * bell * Math.exp(-s / 0.3), j % 2 ? -0.3 : 0.3);
		}
	}
	const blip = (t: number, f: number, gain: number, pan = 0) => {
		for (let k = 0; k < 0.03 * RATE; k++) {
			const s = k / RATE;
			add(
				at(t) + k,
				gain * Math.sin(2 * Math.PI * f * s) * Math.exp(-s / 0.008),
				pan,
			);
		}
	};
	for (const t of m.clicks) blip(t, 1400, 0.3);
	for (const t of m.ticks) blip(t, 2400, 0.05, 0.5);
	for (const [i, t] of m.chips.entries())
		blip(t, 900 + i * 60, 0.12, i % 2 ? 0.5 : -0.5);

	// Fade out the last two seconds, then normalise to -1 dBFS.
	let peak = 0;
	for (let i = 0; i < n; i++) {
		const fade = Math.min(1, (duration - i / RATE) / 2);
		left[i] = (left[i] ?? 0) * fade;
		right[i] = (right[i] ?? 0) * fade;
		peak = Math.max(peak, Math.abs(left[i] ?? 0), Math.abs(right[i] ?? 0));
	}
	const scale = peak > 0 ? 0.89 / peak : 1;

	const wav = Buffer.alloc(44 + n * 4);
	wav.write("RIFF", 0);
	wav.writeUInt32LE(36 + n * 4, 4);
	wav.write("WAVEfmt ", 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(2, 22);
	wav.writeUInt32LE(RATE, 24);
	wav.writeUInt32LE(RATE * 4, 28);
	wav.writeUInt16LE(4, 32);
	wav.writeUInt16LE(16, 34);
	wav.write("data", 36);
	wav.writeUInt32LE(n * 4, 40);
	const pcm = (v: number) =>
		Math.round(Math.max(-1, Math.min(1, v * scale)) * 32767);
	for (let i = 0; i < n; i++) {
		wav.writeInt16LE(pcm(left[i] ?? 0), 44 + i * 4);
		wav.writeInt16LE(pcm(right[i] ?? 0), 46 + i * 4);
	}
	return wav;
}
