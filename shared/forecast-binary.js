(function exposeForecastBinary(root, factory) {
  const forecastBinary = factory();
  if (typeof module === "object" && module.exports) module.exports = forecastBinary;
  else root.DigitalTwinForecastBinary = forecastBinary;
}(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const SCHEMA_VERSION = "2.0";
  const ENCODING = "float32-le";
  const LAYOUT = "field-major";
  const GRID_ORDER = "row-major: north-to-south, west-to-east";
  const PATH_TEMPLATE = "data/ui-surface/t+{leadHours}.bin";
  const BYTES_PER_VALUE = 4;
  const SHA256_PATTERN = /^[a-f0-9]{64}$/;

  const endianProbe = new ArrayBuffer(4);
  new Uint32Array(endianProbe)[0] = 0x01020304;
  const platformIsLittleEndian = new Uint8Array(endianProbe)[0] === 0x04;

  function requireCondition(condition, message) {
    if (!condition) throw new Error(`Invalid binary forecast manifest: ${message}`);
  }

  function requireRelativePath(assetPath, label, allowTemplate = false) {
    requireCondition(typeof assetPath === "string" && assetPath.length > 0, `${label} must be a non-empty string`);
    const comparablePath = allowTemplate ? assetPath.replaceAll("{leadHours}", "0") : assetPath;
    requireCondition(!comparablePath.startsWith("/") && !comparablePath.startsWith("\\"), `${label} must be relative`);
    requireCondition(!/^[a-z][a-z\d+.-]*:/i.test(comparablePath), `${label} must not contain a URL scheme`);
    requireCondition(!comparablePath.split(/[\\/]/).includes(".."), `${label} must not traverse parent directories`);
  }

  function expectedFramePath(pathTemplate, leadHours) {
    return pathTemplate.replaceAll("{leadHours}", String(leadHours));
  }

  function validateManifest(manifest) {
    requireCondition(manifest && typeof manifest === "object", "manifest must be an object");
    requireCondition(manifest.schemaVersion === SCHEMA_VERSION, `schemaVersion must be ${SCHEMA_VERSION}`);

    const product = manifest.uiSurface;
    requireCondition(product && typeof product === "object", "uiSurface is required");
    requireCondition(product.id === "ui-surface", "uiSurface.id must be ui-surface");
    requireCondition(product.encoding === ENCODING, `uiSurface.encoding must be ${ENCODING}`);
    requireCondition(product.layout === LAYOUT, `uiSurface.layout must be ${LAYOUT}`);
    requireCondition(product.bytesPerValue === BYTES_PER_VALUE, `uiSurface.bytesPerValue must be ${BYTES_PER_VALUE}`);
    requireCondition(product.gridOrder === GRID_ORDER, `uiSurface.gridOrder must be ${GRID_ORDER}`);
    requireCondition(product.noData === "IEEE-754 NaN", "uiSurface.noData must be IEEE-754 NaN");
    requireCondition(product.pathTemplate === PATH_TEMPLATE, `uiSurface.pathTemplate must be ${PATH_TEMPLATE}`);
    requireRelativePath(product.pathTemplate, "uiSurface.pathTemplate", true);

    const fields = product.fields;
    requireCondition(Array.isArray(fields) && fields.length > 0, "uiSurface.fields must be a non-empty ordered list");
    fields.forEach((field) => requireCondition(typeof field === "string" && field.length > 0, "each field must be a non-empty string"));
    requireCondition(new Set(fields).size === fields.length, "uiSurface.fields must not contain duplicates");
    requireCondition(product.units && typeof product.units === "object", "uiSurface.units is required");
    fields.forEach((field) => requireCondition(typeof product.units[field] === "string", `uiSurface.units.${field} is required`));
    requireCondition(Object.keys(product.units).length === fields.length, "uiSurface.units must describe only declared fields");

    const layers = manifest.layers;
    requireCondition(Array.isArray(layers) && layers.length === fields.length, "layers must describe every declared field");
    layers.forEach((layer, index) => {
      const field = fields[index];
      requireCondition(layer?.dataField === field, `layer ${index} must describe ${field}`);
      requireCondition(layer.encoding === "ui-grid-float32-le", `layer ${field} must use ui-grid-float32-le`);
      requireCondition(layer.dataTemplate === PATH_TEMPLATE, `layer ${field} must reference the shared binary snapshot`);
      requireCondition(layer.units === product.units[field], `layer ${field} units must match uiSurface.units`);
    });

    const grid = manifest.grid;
    requireCondition(grid && typeof grid === "object", "grid is required");
    requireCondition(Number.isSafeInteger(grid.width) && grid.width > 0, "grid.width must be a positive integer");
    requireCondition(Number.isSafeInteger(grid.height) && grid.height > 0, "grid.height must be a positive integer");
    requireCondition(Array.isArray(grid.longitudeRange) && grid.longitudeRange.length === 2, "grid.longitudeRange must contain two values");
    requireCondition(Array.isArray(grid.latitudeRange) && grid.latitudeRange.length === 2, "grid.latitudeRange must contain two values");

    const leadTimes = manifest.leadTimesHours;
    requireCondition(Array.isArray(leadTimes) && leadTimes.length > 0, "leadTimesHours must be non-empty");
    leadTimes.forEach((lead) => requireCondition(Number.isSafeInteger(lead) && lead >= 0, "leadTimesHours must contain non-negative integers"));
    requireCondition(new Set(leadTimes).size === leadTimes.length, "leadTimesHours must not contain duplicates");
    requireCondition(leadTimes.every((lead, index) => index === 0 || lead > leadTimes[index - 1]), "leadTimesHours must be increasing");

    const cellCount = grid.width * grid.height;
    const valueCount = cellCount * fields.length;
    const expectedByteLength = valueCount * BYTES_PER_VALUE;
    requireCondition(Number.isSafeInteger(expectedByteLength), "snapshot byte length exceeds the safe integer range");

    const files = product.files;
    requireCondition(Array.isArray(files) && files.length === leadTimes.length, "uiSurface.files must describe every lead time exactly once");
    const filesByLead = new Map();
    files.forEach((file, index) => {
      requireCondition(file && typeof file === "object", "each uiSurface.files entry must be an object");
      requireCondition(Number.isSafeInteger(file.leadHours), "each file leadHours must be an integer");
      requireCondition(file.leadHours === leadTimes[index], "uiSurface.files must be in leadTimesHours order");
      requireCondition(leadTimes.includes(file.leadHours), `unexpected file lead time ${file.leadHours}`);
      requireCondition(!filesByLead.has(file.leadHours), `duplicate file entry for lead time ${file.leadHours}`);
      requireRelativePath(file.path, `file path for lead time ${file.leadHours}`);
      requireCondition(file.path === expectedFramePath(product.pathTemplate, file.leadHours), `file path does not match pathTemplate for lead time ${file.leadHours}`);
      requireCondition(file.byteLength === expectedByteLength, `file byteLength is incorrect for lead time ${file.leadHours}`);
      requireCondition(typeof file.sha256 === "string" && SHA256_PATTERN.test(file.sha256), `file sha256 is invalid for lead time ${file.leadHours}`);
      filesByLead.set(file.leadHours, file);
    });
    leadTimes.forEach((lead) => requireCondition(filesByLead.has(lead), `missing file entry for lead time ${lead}`));

    return {
      cellCount,
      expectedByteLength,
      fields: [...fields],
      filesByLead,
      grid,
      product,
      valueCount,
    };
  }

  function frameFile(manifest, leadHours) {
    const contract = validateManifest(manifest);
    requireCondition(Number.isSafeInteger(leadHours), "requested leadHours must be an integer");
    const file = contract.filesByLead.get(leadHours);
    requireCondition(file, `no file is declared for lead time ${leadHours}`);
    return file;
  }

  function decodeLittleEndianFloat32(buffer, valueCount) {
    if (platformIsLittleEndian) return new Float32Array(buffer);
    const source = new DataView(buffer);
    const values = new Float32Array(valueCount);
    for (let index = 0; index < valueCount; index++) values[index] = source.getFloat32(index * BYTES_PER_VALUE, true);
    return values;
  }

  function parseSnapshot(manifest, leadHours, buffer) {
    const contract = validateManifest(manifest);
    requireCondition(contract.filesByLead.has(leadHours), `no file is declared for lead time ${leadHours}`);
    requireCondition(buffer instanceof ArrayBuffer, "snapshot must be an ArrayBuffer");
    requireCondition(buffer.byteLength === contract.expectedByteLength, `snapshot for lead time ${leadHours} has ${buffer.byteLength} bytes; expected ${contract.expectedByteLength}`);

    const values = decodeLittleEndianFloat32(buffer, contract.valueCount);
    const fields = {};
    contract.fields.forEach((field, fieldIndex) => {
      const start = fieldIndex * contract.cellCount;
      fields[field] = values.subarray(start, start + contract.cellCount);
    });

    return {
      byteLength: buffer.byteLength,
      fields,
      grid: contract.grid,
      leadHours,
      units: contract.product.units,
    };
  }

  return Object.freeze({
    BYTES_PER_VALUE,
    ENCODING,
    GRID_ORDER,
    LAYOUT,
    PATH_TEMPLATE,
    SCHEMA_VERSION,
    frameFile,
    parseSnapshot,
    platformIsLittleEndian,
    validateManifest,
  });
}));
