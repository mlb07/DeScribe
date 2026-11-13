// Makes QR codes (the square barcodes a phone camera can scan), as SVG pictures.
// Written here instead of adding an outside package. It follows the QR standard
// (ISO/IEC 18004): byte mode, error correction level M (about 15% of the code can be
// damaged and still read), versions 1 to 10 (up to 213 characters, plenty for a link).

// Error correction level M, per version: [blocks of [count, data codewords]], codewords
// of error correction per block, and where the alignment patterns go.
const VERSIONS = {
  1: { groups: [[1, 16]], ec: 10, align: [] },
  2: { groups: [[1, 28]], ec: 16, align: [6, 18] },
  3: { groups: [[1, 44]], ec: 26, align: [6, 22] },
  4: { groups: [[2, 32]], ec: 18, align: [6, 26] },
  5: { groups: [[2, 43]], ec: 24, align: [6, 30] },
  6: { groups: [[4, 27]], ec: 16, align: [6, 34] },
  7: { groups: [[4, 31]], ec: 18, align: [6, 22, 38] },
  8: { groups: [[2, 38], [2, 39]], ec: 22, align: [6, 24, 42] },
  9: { groups: [[3, 36], [2, 37]], ec: 22, align: [6, 26, 46] },
  10: { groups: [[4, 43], [1, 44]], ec: 26, align: [6, 28, 50] },
};

const dataCodewords = (version) => VERSIONS[version].groups.reduce((sum, [count, size]) => sum + count * size, 0);

// --- Arithmetic in GF(256), used for the error correction ---------------------------

function multiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function divisor(degree) {
  const result = new Array(degree - 1).fill(0).concat([1]);
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = multiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = multiply(root, 0x02);
  }
  return result;
}

function remainder(data, by) {
  const result = by.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    by.forEach((coefficient, i) => {
      result[i] ^= multiply(coefficient, factor);
    });
  }
  return result;
}

// --- Turning the text into codewords ------------------------------------------------

function codewords(bytes, version) {
  const bits = [];
  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) put(byte, 8);
  const capacity = dataCodewords(version) * 8;
  put(0, Math.min(4, capacity - bits.length)); // end marker
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  for (let pad = 0xec; data.length < dataCodewords(version); pad ^= 0xec ^ 0x11) data.push(pad);

  // Split into blocks, add error correction to each, then interleave.
  const { groups, ec } = VERSIONS[version];
  const by = divisor(ec);
  const blocks = [];
  let at = 0;
  for (const [count, size] of groups) {
    for (let k = 0; k < count; k += 1) {
      const part = data.slice(at, at + size);
      at += size;
      blocks.push({ data: part, ec: remainder(part, by) });
    }
  }
  const result = [];
  const longest = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < longest; i += 1) for (const block of blocks) if (i < block.data.length) result.push(block.data[i]);
  for (let i = 0; i < ec; i += 1) for (const block of blocks) result.push(block.ec[i]);
  return result;
}

// --- Drawing the grid -----------------------------------------------------------------

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function grid(version, words, mask) {
  const size = version * 4 + 17;
  const dark = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, value) => {
    dark[y][x] = value;
    fixed[y][x] = true;
  };

  // Timing lines, then the three corner squares, then the small alignment squares.
  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, distance !== 2 && distance !== 4);
      }
    }
  }
  const align = VERSIONS[version].align;
  align.forEach((cx, i) => {
    align.forEach((cy, j) => {
      const corner = (i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0);
      if (corner) return;
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    });
  });

  // Format information (error level M = 0b00, and the mask), twice.
  const format = (0b00 << 3) | mask;
  let rem = format;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const formatBits = ((format << 10) | rem) ^ 0x5412;
  const bit = (value, i) => ((value >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i += 1) set(8, i, bit(formatBits, i));
  set(8, 7, bit(formatBits, 6));
  set(8, 8, bit(formatBits, 7));
  set(7, 8, bit(formatBits, 8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(formatBits, i));
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(formatBits, i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(formatBits, i));
  set(8, size - 8, true); // always dark

  // Version information (versions 7 and up), twice.
  if (version >= 7) {
    let vrem = version;
    for (let i = 0; i < 12; i += 1) vrem = (vrem << 1) ^ ((vrem >>> 11) * 0x1f25);
    const versionBits = (version << 12) | vrem;
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(versionBits, i));
      set(b, a, bit(versionBits, i));
    }
  }

  // The data, in the zigzag order, two columns at a time from the bottom right.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fixed[y][x] && i < words.length * 8) {
          dark[y][x] = bit(words[i >>> 3], 7 - (i & 7));
          i += 1;
        }
      }
    }
  }

  // The mask flips data modules in a pattern so the code is easy for cameras to read.
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (!fixed[y][x] && MASKS[mask](x, y)) dark[y][x] = !dark[y][x];
  return dark;
}

// How hard a grid is for a camera to read (lower is better), per the standard's rules.
function penalty(dark) {
  const size = dark.length;
  let score = 0;
  const lines = [...dark, ...dark[0].map((_, x) => dark.map((row) => row[x]))];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i += 1) {
      if (i < size && line[i] === line[i - 1]) run += 1;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    const text = line.map((d) => (d ? 1 : 0)).join('');
    score += 40 * ((text.match(/(?=10111010000)/g) || []).length + (text.match(/(?=00001011101)/g) || []).length);
  }
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const c = dark[y][x];
      if (c === dark[y][x + 1] && c === dark[y + 1][x] && c === dark[y + 1][x + 1]) score += 3;
    }
  }
  const darkCount = dark.flat().filter(Boolean).length;
  score += Math.floor(Math.abs(darkCount * 20 - size * size * 10) / (size * size)) * 10;
  return score;
}

// The QR code for a piece of text, as rows of true (dark) / false (light).
// "mask" can force one of the 8 patterns (used to check them all); normally the best is chosen.
export function qrMatrix(text, mask = null) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  const version = Object.keys(VERSIONS)
    .map(Number)
    .find((v) => 4 + (v <= 9 ? 8 : 16) + bytes.length * 8 <= dataCodewords(v) * 8);
  if (!version) throw new Error('That is too long for a QR code here.');
  const words = codewords(bytes, version);
  if (mask !== null) return grid(version, words, mask);
  let best = null;
  for (let tryMask = 0; tryMask < 8; tryMask += 1) {
    const candidate = grid(version, words, tryMask);
    const score = penalty(candidate);
    if (!best || score < best.score) best = { candidate, score };
  }
  return best.candidate;
}

// The QR code as an SVG picture, with the white border cameras need around it.
export function qrSvg(text, mask = null) {
  const dark = qrMatrix(text, mask);
  const size = dark.length + 8;
  let path = '';
  dark.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) path += `M${x + 4} ${y + 4}h1v1h-1z`;
    }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
