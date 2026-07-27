import fs from 'node:fs/promises';
import path from 'node:path';

export const EXPECTED_PERSISTENT_OUTPUTS = Object.freeze([
  'generator.py',
  'manifest.json',
  'generator_report.json'
]);

function normalizeFiles(files) {
  if (!Array.isArray(files)) return [];

  return files
    .map((file) => {
      if (typeof file === 'string') {
        return {
          path: file,
          name: path.basename(file)
        };
      }

      const filePath = file?.path
        ? String(file.path)
        : '';

      const fileName = file?.name
        ? String(file.name)
        : path.basename(filePath);

      return {
        path: filePath,
        name: fileName
      };
    })
    .filter((file) => file.path || file.name);
}

export async function verifyOutputCompleteness({
  files,
  expectedFileNames = EXPECTED_PERSISTENT_OUTPUTS
}) {
  const normalized = normalizeFiles(files);
  const expected = [...new Set(
    (expectedFileNames || []).map((name) => String(name))
  )];

  const observedFileNames = normalized.map((file) => file.name);
  const counts = new Map();

  for (const name of observedFileNames) {
    counts.set(name, (counts.get(name) || 0) + 1);
  }

  const duplicateFileNames = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();

  const expectedSet = new Set(expected);
  const extraFileNames = [...new Set(
    observedFileNames.filter((name) => !expectedSet.has(name))
  )].sort();

  const missingFileNames = expected
    .filter((name) => !counts.has(name))
    .sort();

  const emptyFileNames = [];
  const unreadableFileNames = [];
  const fileDetails = [];
  let totalBytes = 0;

  for (const expectedName of expected) {
    const candidates = normalized.filter(
      (file) => file.name === expectedName
    );

    if (candidates.length === 0) continue;

    const candidate = candidates[0];

    try {
      const stat = await fs.stat(candidate.path);
      const isRegularFile = stat.isFile();
      const sizeBytes = isRegularFile ? stat.size : 0;

      if (!isRegularFile) {
        unreadableFileNames.push(expectedName);
      } else if (sizeBytes === 0) {
        emptyFileNames.push(expectedName);
      } else {
        totalBytes += sizeBytes;
      }

      fileDetails.push({
        fileName: expectedName,
        filePath: candidate.path,
        exists: true,
        isRegularFile,
        sizeBytes
      });
    } catch (err) {
      unreadableFileNames.push(expectedName);
      fileDetails.push({
        fileName: expectedName,
        filePath: candidate.path,
        exists: false,
        isRegularFile: false,
        sizeBytes: 0,
        errorCode: err?.code || 'stat_failed'
      });
    }
  }

  missingFileNames.sort();
  emptyFileNames.sort();
  unreadableFileNames.sort();

  const complete =
    missingFileNames.length === 0 &&
    emptyFileNames.length === 0 &&
    unreadableFileNames.length === 0 &&
    duplicateFileNames.length === 0;

  return {
    complete,
    expectedFileNames: expected,
    observedFileNames,
    missingFileNames,
    emptyFileNames,
    unreadableFileNames,
    duplicateFileNames,
    extraFileNames,
    expectedFileCount: expected.length,
    observedFileCount: normalized.length,
    verifiedFileCount: fileDetails.filter(
      (file) =>
        file.exists &&
        file.isRegularFile &&
        file.sizeBytes > 0
    ).length,
    totalBytes,
    fileDetails
  };
}