/**
 * project.ts — Load any supported project file into the model, and export it.
 * No VS Code dependency, so tests and scripts can use it directly.
 */

import * as path from 'path';
import { decodeAcd } from './acd/decoder';
import { parseL5x } from './l5x/parse';
import { Controller } from './model';
import { ExportOptions, ExportSummary, exportDirFor, fingerprintOf, runExport } from './export/exporter';

export const PROJECT_EXTENSIONS = ['.acd', '.l5x'];
export const PROJECT_GLOB = '**/*.{ACD,acd,L5X,l5x}';

export function isProjectFile(p: string): boolean {
  return PROJECT_EXTENSIONS.includes(path.extname(p).toLowerCase());
}

export function loadProject(filePath: string): Controller {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.acd') return decodeAcd(filePath).controller;
  if (ext === '.l5x') return parseL5x(filePath);
  throw new Error(`Unsupported file type ${ext}: expected .ACD or .L5X`);
}

export interface ExportResult {
  controller: Controller;
  summary: ExportSummary;
  ms: number;
}

/** Decode and export in one step. The fingerprint is taken before reading. */
export function exportProject(filePath: string, storageRoot: string, opts: ExportOptions = {}): ExportResult {
  const started = Date.now();
  const fp = fingerprintOf(filePath);
  const controller = loadProject(filePath);
  const summary = runExport(controller, exportDirFor(storageRoot, filePath), fp, opts);
  return { controller, summary, ms: Date.now() - started };
}
