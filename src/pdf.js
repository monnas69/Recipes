/**
 * Optional PDF export.
 *
 * Two backends, tried in order:
 *   1. puppeteer / puppeteer-core, if installed (best fidelity, honours @media print)
 *   2. any local Chrome/Chromium binary via --headless --print-to-pdf
 *
 * Neither is a dependency: without them `--pdf` fails with an actionable message
 * and the HTML export is unaffected.
 */

import { access, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const run = promisify(execFile);

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.PLAYWRIGHT_BROWSERS_PATH ? path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium') : null,
  '/opt/pw-browsers/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'
].filter(Boolean);

async function isExecutable(file) {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Locate a usable Chrome/Chromium binary, or null. */
export async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (await isExecutable(candidate)) return candidate;
  }
  for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'chrome']) {
    try {
      const { stdout } = await run('which', [name]);
      const found = stdout.trim();
      if (found && (await isExecutable(found))) return found;
    } catch { /* not on PATH */ }
  }
  return null;
}

async function loadPuppeteer() {
  for (const name of ['puppeteer', 'puppeteer-core']) {
    try {
      const mod = await import(name);
      return { mod: mod.default || mod, name };
    } catch { /* not installed */ }
  }
  return null;
}

/**
 * Render an already-written HTML file to PDF next to it.
 * @returns {Promise<{pdfPath: string, backend: string}>}
 */
export async function htmlFileToPdf(htmlPath, pdfPath, options = {}) {
  const url = pathToFileURL(path.resolve(htmlPath)).href;
  const puppeteer = await loadPuppeteer();

  if (puppeteer) {
    const launchOptions = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
    const executablePath = options.chromePath || (await findChrome());
    if (executablePath && puppeteer.name === 'puppeteer-core') launchOptions.executablePath = executablePath;
    const browser = await puppeteer.mod.launch(launchOptions);
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle0' });
      await page.emulateMediaType('print');
      await page.pdf({
        path: pdfPath,
        format: options.pageFormat || 'A4',
        printBackground: true,
        margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' }
      });
      return { pdfPath, backend: puppeteer.name };
    } finally {
      await browser.close();
    }
  }

  const chrome = options.chromePath || (await findChrome());
  if (!chrome) {
    throw new Error(
      'PDF export needs a headless browser. Install puppeteer (`npm i puppeteer`) ' +
      'or point CHROME_PATH at a Chrome/Chromium binary.'
    );
  }

  // Chrome writes to the path given to --print-to-pdf; use a temp dir so a
  // failed run never clobbers an existing PDF.
  const tmpDir = path.join(os.tmpdir(), `ninja-pdf-${process.pid}-${Date.now()}`);
  const tmpFile = path.join(tmpDir, 'card.pdf');
  await run('mkdir', ['-p', tmpDir]);
  try {
    await run(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-pdf-header-footer',
      '--virtual-time-budget=4000',
      `--print-to-pdf=${tmpFile}`,
      url
    ], { timeout: options.timeout || 60000 });
    await rename(tmpFile, pdfPath);
    return { pdfPath, backend: `chrome (${path.basename(chrome)})` };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
