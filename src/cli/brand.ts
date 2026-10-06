/** Terminal artwork: the HSE seal and a wordmark, without image protocols or dependencies. */
type Ink = 'blue' | 'white';
type Pixel = Ink | undefined;
type Bitmap = Pixel[][];
export interface BrandOptions { columns: number; colorDepth: number }

const font: Record<string, string[]> = {
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  N: ['10001', '11001', '11001', '10101', '10011', '10011', '10001'],
};

// The double stem and open counters distinguish the HSE monogram from an ordinary letter B.
const monogram = [
  '111111110000',
  '101000011100',
  '101000000110',
  '101000000010',
  '101000000010',
  '101000000110',
  '101000011100',
  '101111110000',
  '101000011100',
  '101000000110',
  '101000000011',
  '101000000001',
  '101000000001',
  '101000000001',
  '101000000001',
  '101000000001',
  '101000000001',
  '101000000011',
  '111111111111',
];
const compactMonogram = [
  '11111000', '10100110', '10100010', '10100110',
  '10111000', '10100110', '10100011', '10100001',
  '10100001', '10100001', '10100011', '11111111',
];

function seal(size: number): Bitmap {
  const pixels: Bitmap = Array.from({ length: size }, () => Array<Pixel>(size));
  const radius = size / 2 - 0.5;
  for (const [y, row] of pixels.entries()) {
    for (let x = 0; x < size; x++) {
      if (Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) <= radius) row[x] = 'blue';
    }
  }
  const mark = size < 28 ? compactMonogram : monogram;
  const height = mark.length, width = mark[0]!.length;
  const left = Math.floor((size - width) / 2), top = Math.floor((size - height) / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mark[y]![x] === '1') pixels[top + y]![left + x] = 'white';
    }
  }
  // Two white points recall the circular inscription in the original university seal.
  for (const x of [Math.round(size * 0.12), Math.round(size * 0.87)]) pixels[Math.round(size * 0.4)]![x] = 'white';
  return pixels;
}

function lettering(word: string, ink: Ink): Bitmap {
  return Array.from({ length: 8 }, (_, row) => [...word].flatMap((letter, index) => {
    const pixels: Pixel[] = [...(font[letter]![row] ?? '00000')].map(value => value === '1' ? ink : undefined);
    return index ? [undefined, ...pixels] : pixels;
  }));
}

function escape(ink: Ink, background: boolean, depth: number, emblem: boolean): string {
  const channel = background ? 48 : 38;
  if (depth >= 24) {
    const rgb = ink === 'white' ? '245;248;255' : emblem ? '19;44;101' : '86;155;255';
    return `\x1b[${channel};2;${rgb}m`;
  }
  if (depth >= 8) return `\x1b[${channel};5;${ink === 'white' ? 255 : emblem ? 18 : 75}m`;
  return `\x1b[${ink === 'white' ? background ? 107 : 97 : background ? 44 : 94}m`;
}

/** Half blocks make each pixel approximately square in a terminal's tall character cells. */
function paint(pixels: Bitmap, depth: number, emblem = false): string[] {
  const lines: string[] = [];
  for (let y = 0; y < pixels.length; y += 2) {
    const upper = pixels[y]!;
    let line = '';
    for (let x = 0; x < upper.length; x++) {
      const top = upper[x], bottom = pixels[y + 1]?.[x];
      if (!top && !bottom) { line += ' '; continue; }
      if (depth < 4) {
        line += !emblem || top === 'white' || bottom === 'white' ? '█' : '░';
        continue;
      }
      const glyph = top === bottom ? '█' : top ? '▀' : '▄';
      line += escape(top ?? bottom!, false, depth, emblem);
      if (top && bottom && top !== bottom) line += escape(bottom, true, depth, emblem);
      line += glyph + '\x1b[0m';
    }
    lines.push(line);
  }
  return lines;
}

function text(value: string, ink: Ink, depth: number): string {
  return depth < 4 ? value : `\x1b[1m${escape(ink, false, depth, false)}${value}\x1b[0m`;
}

/** Select an entire layout before rendering, so artwork never wraps into prompts. */
export function brand({ columns, colorDepth }: BrandOptions): string {
  const margin = columns >= 48 ? '  ' : '';
  if (columns < 40) return ['HSE HARNESS', 'ВЫСШАЯ ШКОЛА ЭКОНОМИКИ'].map(line => text(line, 'white', colorDepth)).join('\n');
  const full = columns >= 76;
  const badge = paint(seal(full ? 28 : 18), colorDepth, true);
  const right = full
    ? [text('ВЫСШАЯ ШКОЛА ЭКОНОМИКИ', 'white', colorDepth), '', ...paint(lettering('HSE', 'blue'), colorDepth), '', ...paint(lettering('HARNESS', 'white'), colorDepth), '', text('Твой помощник по учёбе', 'blue', colorDepth)]
    : ['', text('HSE', 'blue', colorDepth), text('HARNESS', 'white', colorDepth), '', 'ВЫСШАЯ ШКОЛА', 'ЭКОНОМИКИ', '', 'Помощник по учёбе'];
  return Array.from({ length: Math.max(badge.length, right.length) }, (_, row) =>
    margin + (badge[row] ?? ' '.repeat(full ? 28 : 18)) + '   ' + (right[row] ?? '')
  ).join('\n');
}

export function showBrand(output: NodeJS.WriteStream = process.stdout): void {
  if (!output.isTTY || process.env.TERM === 'dumb') return;
  const depth = 'NO_COLOR' in process.env || process.env.FORCE_COLOR === '0' ? 1 : output.getColorDepth();
  output.write('\n' + brand({ columns: output.columns || 80, colorDepth: depth }) + '\n\n');
}
