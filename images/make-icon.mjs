import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const S = 128;

// palette
const BG = [0x0c, 0x1a, 0x2b, 255]; // deep navy
const DIE = [0x13, 0x2a, 0x42, 255]; // slightly lighter die fill
const EDGE = [0x34, 0xd3, 0x99, 255]; // teal
const PIN = [0x34, 0xd3, 0x99, 255];
const CORE = [0x8b, 0xe9, 0xcf, 255]; // lighter teal accent

const buf = new Uint8Array(S * S * 4);
const put = (x, y, c) => {
	if (x < 0 || y < 0 || x >= S || y >= S) return;
	const i = (y * S + x) * 4;
	buf[i] = c[0];
	buf[i + 1] = c[1];
	buf[i + 2] = c[2];
	buf[i + 3] = c[3];
};

// background
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) put(x, y, BG);

// rounded-rect helper
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
	if (x < x0 || x > x1 || y < y0 || y > y1) return false;
	const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
	const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
	return (x - cx) ** 2 + (y - cy) ** 2 <= r * r + 1;
};

// pins: 4 per side, sticking out of the die
const die0 = 30,
	die1 = 98;
const pinW = 7,
	pinLen = 12;
const pinCenters = [40, 58, 70, 88];
for (const c of pinCenters) {
	for (let d = 0; d < pinLen; d++) {
		for (let w = 0; w < pinW; w++) {
			put(c - 3 + w, die0 - 1 - d, PIN); // top
			put(c - 3 + w, die1 + 1 + d, PIN); // bottom
			put(die0 - 1 - d, c - 3 + w, PIN); // left
			put(die1 + 1 + d, c - 3 + w, PIN); // right
		}
	}
}

// die body (rounded square) with a teal edge
for (let y = 0; y < S; y++) {
	for (let x = 0; x < S; x++) {
		const outer = inRoundRect(x, y, die0, die0, die1, die1, 14);
		const inner = inRoundRect(x, y, die0 + 6, die0 + 6, die1 - 6, die1 - 6, 9);
		if (outer && !inner) put(x, y, EDGE);
		else if (inner) put(x, y, DIE);
	}
}

// core: a small rounded square in the centre
for (let y = 0; y < S; y++)
	for (let x = 0; x < S; x++)
		if (inRoundRect(x, y, 56, 56, 72, 72, 4)) put(x, y, CORE);

// trace stubs from the core to each side
for (let t = 0; t < 12; t++) {
	put(64, 44 + t, EDGE);
	put(63, 44 + t, EDGE);
	put(64, 72 + t, EDGE);
	put(63, 72 + t, EDGE);
	put(44 + t, 64, EDGE);
	put(44 + t, 63, EDGE);
	put(72 + t, 64, EDGE);
	put(72 + t, 63, EDGE);
}

// ---- PNG encode ----
const crcTable = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();
const crc32 = (bytes) => {
	let c = 0xffffffff;
	for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
	const len = data.length;
	const out = new Uint8Array(12 + len);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, len);
	out.set([...type].map((ch) => ch.charCodeAt(0)), 4);
	out.set(data, 8);
	const typeAndData = out.subarray(4, 8 + len);
	dv.setUint32(8 + len, crc32(typeAndData));
	return out;
};

// filtered raw: filter byte 0 per scanline
const raw = new Uint8Array(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
	raw[y * (S * 4 + 1)] = 0;
	raw.set(buf.subarray(y * S * 4, (y + 1) * S * 4), y * (S * 4 + 1) + 1);
}
const idat = deflateSync(raw, { level: 9 });

const ihdr = new Uint8Array(13);
const idv = new DataView(ihdr.buffer);
idv.setUint32(0, S);
idv.setUint32(4, S);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const png = Buffer.concat([
	Buffer.from(sig),
	Buffer.from(chunk('IHDR', ihdr)),
	Buffer.from(chunk('IDAT', idat)),
	Buffer.from(chunk('IEND', new Uint8Array(0))),
]);

mkdirSync('images', { recursive: true });
writeFileSync('images/icon.png', png);
console.log('wrote images/icon.png', png.length, 'bytes');
