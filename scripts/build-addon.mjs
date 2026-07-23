import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import zlib from "node:zlib";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "addon");
const staging = path.join(root, ".build", "addon");
const dist = path.join(root, "dist");
const archive = path.join(dist, "marginnote-agent.mnaddon");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function createIcon() {
  const width = 64;
  const height = 64;
  const rowSize = width * 4 + 1;
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * rowSize] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = y * rowSize + 1 + x * 4;
      const gradient = Math.round((x + y) * 0.55);
      let red = 43;
      let green = Math.min(146 + gradient, 205);
      let blue = Math.min(255, 235 + Math.round(gradient / 3));

      const leftStem = x >= 15 && x <= 21 && y >= 14 && y <= 49;
      const rightStem = x >= 42 && x <= 48 && y >= 14 && y <= 49;
      const leftDiagonal = x >= 20 && x <= 32 && Math.abs(y - (x + 3)) <= 3;
      const rightDiagonal = x >= 31 && x <= 43 && Math.abs(y - (66 - x)) <= 3;
      if (leftStem || rightStem || leftDiagonal || rightDiagonal) {
        red = 255;
        green = 255;
        blue = 255;
      }

      raw[offset] = red;
      raw[offset + 1] = green;
      raw[offset + 2] = blue;
      raw[offset + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

await rm(path.join(root, ".build"), { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await mkdir(dist, { recursive: true });
await cp(source, staging, { recursive: true, filter: (entry) => !entry.endsWith("icon.png") });
await writeFile(path.join(staging, "icon.png"), createIcon());
JSON.parse(await readFile(path.join(staging, "mnaddon.json"), "utf8"));
await rm(archive, { force: true });
await execFileAsync("/usr/bin/zip", ["-q", "-r", archive, "."], { cwd: staging });
console.log(archive);
