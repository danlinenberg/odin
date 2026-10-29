/**
 * The trailer's sound (site/trailer.html): a music track and sound effects from
 * Mixkit, free for commercial use without attribution under the Mixkit Stock
 * Music and Sound Effects Free Licenses (https://mixkit.co/license/). They're
 * fetched when the trailer is rendered and mixed into the video; none of them
 * are kept in the repo.
 *
 * The track is "Ramp It Up" by Ahjay Stelino, 120 BPM. It starts where its
 * hardest hit lands on the end of the hook, and its own ending falls on the
 * close. Every effect sits on one of the trailer's moments (window.MOMENTS),
 * at the effect's loudest point, so a change to the timeline moves them too.
 *
 * trailerAudio(moments, ffmpeg) is a 16-bit stereo WAV; site-demo.ts muxes it in.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RATE = 44_100;

/** The trailer's moments, from window.MOMENTS in site/trailer.html. */
export type Moments = {
	duration: number;
	/** The video's poster frame. */
	poster: number;
	hookWords: number[];
	hookAnswer: number;
	/** Where the music's drop lands: the cut out of the hook. */
	grooveFrom: number;
	/** Scene cuts: a whoosh into each. */
	cuts: number[];
	pings: number[];
	/** Buttons pressed. */
	clicks: number[];
	/** Things flying across: sessions to the host. */
	whooshes: number[];
	/** The draft typing itself out. */
	typing: [number, number];
	chips: number[];
	/** The brief's links landing. */
	pops: number[];
	close: number;
};

const MUSIC = "https://assets.mixkit.co/music/69/69.mp3";
// The track's hardest hit: the drop, put on the end of the hook.
const DROP_AT = 63.9;
// Where its ending has faded out.
const TRACK_END = 97.8;
// A trailer longer than the track repeats the bars before this point, a beat
// ahead of the next section's hit, so the ending still lands on the close.
const LOOP_END = 79.65;
const BAR = 2;
// Four bars: what repeats, so a long extension never reaches back to the drop.
const LOOP = 4 * BAR;
const sfx = (id: number) =>
	`https://assets.mixkit.co/active_storage/sfx/${id}/${id}-preview.mp3`;
const SFX = {
	hookWord: sfx(2150), // Impact of a blow
	hookAnswer: sfx(2908), // Movie trailer epic impact
	cut: [sfx(1492), sfx(1490)], // Cinematic whoosh fast transition, Fast whoosh transition
	fly: sfx(166), // Fast small sweep transition
	click: sfx(2568), // Cool interface click tone
	pings: [sfx(2354), sfx(951), sfx(2867)], // Message pop alert, Positive notification, Confirmation tone
	typing: sfx(1396), // Soft typing on a digital keyboard
	chip: sfx(3005), // Explainer video pops whoosh light pop
	close: sfx(2900), // Movie logo intro impact
};

type Clip = { left: Float32Array; right: Float32Array; peak: number };

/** A sound as stereo floats at RATE, fetched once into a temp cache. */
async function load(url: string, ffmpeg: string): Promise<Clip> {
	const cache = join(tmpdir(), "odin-trailer-audio");
	mkdirSync(cache, { recursive: true });
	const file = join(cache, url.replace(/[^A-Za-z0-9.]+/g, "_"));
	if (!existsSync(file)) {
		const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
		if (!res.ok) throw new Error(`${url}: ${res.status}`);
		writeFileSync(file, Buffer.from(await res.arrayBuffer()));
	}
	const pcm = Bun.spawnSync(
		[
			ffmpeg,
			"-loglevel",
			"error",
			"-i",
			file,
			"-ac",
			"2",
			"-ar",
			String(RATE),
			"-f",
			"f32le",
			"-",
		],
		{ stderr: "inherit" },
	).stdout;
	const all = new Float32Array(
		pcm.buffer,
		pcm.byteOffset,
		Math.floor(pcm.byteLength / 4),
	);
	const n = all.length / 2;
	const left = new Float32Array(n);
	const right = new Float32Array(n);
	// Its loudest moment, over 10 ms windows: what lines up with a cue.
	let peak = 0;
	let loudest = 0;
	const win = Math.round(RATE / 100);
	for (let i = 0; i < n; i++) {
		left[i] = all[2 * i] ?? 0;
		right[i] = all[2 * i + 1] ?? 0;
	}
	for (let w = 0; w + win <= n; w += win) {
		let e = 0;
		for (let i = w; i < w + win; i++)
			e += (left[i] ?? 0) ** 2 + (right[i] ?? 0) ** 2;
		if (e > loudest) {
			loudest = e;
			peak = w / RATE;
		}
	}
	return { left, right, peak };
}

export async function trailerAudio(
	m: Moments,
	ffmpeg: string,
): Promise<Buffer> {
	const n = Math.ceil(m.duration * RATE);
	const left = new Float32Array(n);
	const right = new Float32Array(n);
	/** Mixes `clip` in from its second `from` for `length` seconds, starting at `at`. */
	const place = (
		clip: Clip,
		at: number,
		gain: number,
		from = 0,
		length = Infinity,
		fade = 0,
	) => {
		const start = Math.round(at * RATE);
		const skip = Math.round(from * RATE);
		const count = Math.min(clip.left.length - skip, Math.round(length * RATE));
		const fadeN = Math.round(fade * RATE);
		for (let k = 0; k < count; k++) {
			const i = start + k;
			if (i < 0) continue;
			if (i >= n) break;
			const g = gain * (fadeN && k > count - fadeN ? (count - k) / fadeN : 1);
			left[i] = (left[i] ?? 0) + g * (clip.left[skip + k] ?? 0);
			right[i] = (right[i] ?? 0) + g * (clip.right[skip + k] ?? 0);
		}
	};
	/** The clip's loudest point on `t`. */
	const hit = (clip: Clip, t: number, gain: number) =>
		place(clip, t - clip.peak, gain);

	const [music, hookWord, hookAnswer, fly, click, typing, chip, close] =
		await Promise.all(
			[
				MUSIC,
				SFX.hookWord,
				SFX.hookAnswer,
				SFX.fly,
				SFX.click,
				SFX.typing,
				SFX.chip,
				SFX.close,
			].map((u) => load(u, ffmpeg)),
		);
	const cuts = await Promise.all(SFX.cut.map((u) => load(u, ffmpeg)));
	const pings = await Promise.all(SFX.pings.map((u) => load(u, ffmpeg)));

	// The track, its drop on the end of the hook, running out on its own ending:
	// whatever the trailer runs past the track repeats, in whole bars.
	const start = DROP_AT - m.grooveFrom;
	const extra = Math.max(
		0,
		Math.round((m.duration - (TRACK_END - start)) / BAR) * BAR,
	);
	const seam = 0.02;
	place(music, 0, 0.75, start, LOOP_END - start + seam, seam);
	// The repeat: the last LOOP bars before LOOP_END, as many times as it takes
	// (a part of them first when the extra isn't a whole number of them).
	let at = LOOP_END - start;
	for (let left = extra; left > 0; ) {
		const part = left % LOOP || LOOP;
		place(music, at, 0.75, LOOP_END - part, part + seam, seam);
		at += part;
		left -= part;
	}
	place(music, at, 0.75, LOOP_END);

	for (const t of m.hookWords) hit(hookWord, t, 0.55);
	hit(hookAnswer, m.hookAnswer, 0.6);
	for (const [i, t] of m.cuts.entries()) {
		const whoosh = cuts[i % cuts.length];
		if (whoosh) hit(whoosh, t, 0.75);
	}
	for (const t of m.whooshes) hit(fly, t + 0.3, 0.4);
	for (const t of m.clicks) hit(click, t, 0.55);
	for (const [i, t] of m.pings.entries()) {
		const ping = pings[i % pings.length];
		if (ping) hit(ping, t + 0.15, 0.6);
	}
	place(typing, m.typing[0], 0.5, 1, m.typing[1] - m.typing[0] + 0.15, 0.15);
	for (const t of m.chips) hit(chip, t, 0.18);
	for (const t of m.pops) hit(chip, t, 0.4);
	hit(close, m.close, 0.85);

	// A soft limiter, then -1 dBFS at the peak.
	let peak = 0;
	for (const ch of [left, right])
		for (let i = 0; i < n; i++) {
			const v = ch[i] ?? 0;
			ch[i] = Math.tanh(v * 1.1) / Math.tanh(1.1);
			peak = Math.max(peak, Math.abs(ch[i] ?? 0));
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
