const assert = require("node:assert/strict");
const forecastBinary = require("../shared/forecast-binary.js");

const fields = ["temperature", "rain", "windU"];
const cellCount = 4;
const byteLength = fields.length * cellCount * Float32Array.BYTES_PER_ELEMENT;
const sha256 = "a".repeat(64);
const manifest = {
  schemaVersion: "2.0",
  grid: {
    width: 2,
    height: 2,
    longitudeRange: [-180, 180],
    latitudeRange: [90, -90],
  },
  leadTimesHours: [0, 6],
  layers: fields.map((field) => ({
    dataField: field,
    dataTemplate: "data/ui-surface/t+{leadHours}.bin",
    encoding: "ui-grid-float32-le",
    units: { temperature: "C", rain: "mm per 6 h", windU: "m s-1" }[field],
  })),
  uiSurface: {
    id: "ui-surface",
    encoding: "float32-le",
    pathTemplate: "data/ui-surface/t+{leadHours}.bin",
    layout: "field-major",
    fields,
    bytesPerValue: 4,
    gridOrder: "row-major: north-to-south, west-to-east",
    noData: "IEEE-754 NaN",
    units: { temperature: "C", rain: "mm per 6 h", windU: "m s-1" },
    files: [
      { leadHours: 0, path: "data/ui-surface/t+0.bin", byteLength, sha256 },
      { leadHours: 6, path: "data/ui-surface/t+6.bin", byteLength, sha256 },
    ],
  },
};

function makeLittleEndianSnapshot(values) {
  const buffer = new ArrayBuffer(values.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(buffer);
  values.forEach((value, index) => view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, value, true));
  return buffer;
}

const values = [
  10.25, 11.5, Number.NaN, -4.75,
  0, 2.5, 8.75, 12,
  -3, 4, 5.5, -6.25,
];
const buffer = makeLittleEndianSnapshot(values);
const surface = forecastBinary.parseSnapshot(manifest, 6, buffer);

assert.deepEqual([...surface.fields.temperature.slice(0, 2)], [10.25, 11.5]);
assert.ok(Number.isNaN(surface.fields.temperature[2]));
assert.equal(surface.fields.temperature[3], -4.75);
assert.deepEqual([...surface.fields.rain], [0, 2.5, 8.75, 12]);
assert.deepEqual([...surface.fields.windU], [-3, 4, 5.5, -6.25]);
assert.equal(surface.byteLength, byteLength);
assert.equal(surface.grid, manifest.grid);
assert.equal(forecastBinary.frameFile(manifest, 6).path, "data/ui-surface/t+6.bin");
if (forecastBinary.platformIsLittleEndian) {
  assert.equal(surface.fields.temperature.buffer, buffer);
  assert.equal(surface.fields.rain.buffer, buffer);
  assert.equal(surface.fields.rain.byteOffset, cellCount * Float32Array.BYTES_PER_ELEMENT);
}

assert.throws(
  () => forecastBinary.parseSnapshot(manifest, 6, new ArrayBuffer(byteLength - 4)),
  /expected 48/,
);
assert.throws(
  () => forecastBinary.validateManifest({ ...manifest, schemaVersion: "1.0" }),
  /schemaVersion must be 2\.0/,
);
assert.throws(
  () => forecastBinary.validateManifest({
    ...manifest,
    uiSurface: { ...manifest.uiSurface, encoding: "json" },
  }),
  /encoding must be float32-le/,
);
assert.throws(
  () => forecastBinary.validateManifest({
    ...manifest,
    uiSurface: { ...manifest.uiSurface, fields: ["temperature", "temperature", "windU"] },
  }),
  /must not contain duplicates/,
);
assert.throws(
  () => forecastBinary.validateManifest({
    ...manifest,
    uiSurface: {
      ...manifest.uiSurface,
      files: manifest.uiSurface.files.map((file, index) => (
        index === 1 ? { ...file, byteLength: byteLength + 4 } : file
      )),
    },
  }),
  /byteLength is incorrect/,
);
assert.throws(
  () => forecastBinary.validateManifest({
    ...manifest,
    layers: [...manifest.layers].reverse(),
  }),
  /layer 0 must describe temperature/,
);

console.log("Float32 binary manifest validation, field offsets, little-endian decoding, and NaN handling passed.");
