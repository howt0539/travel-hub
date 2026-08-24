#!/usr/bin/env node

import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createConnection, isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';


const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const LONG_TEXT = '這是一段用來驗證手機版表單不會超出畫面的最長內容 ResponsiveLayoutGuard1234567890';


export function buildProfiles() {
  const sweepWidths = [];
  for (let width = 320; width <= 430; width += 10) sweepWidths.push(width);
  sweepWidths.push(402, 430);

  const widthProfiles = [...new Set(sweepWidths)]
    .sort((left, right) => left - right)
    .map((width) => ({
      name: `width-${width}`,
      browser: 'chromium',
      viewport: { width, height: 874 },
      screen: { width, height: 874 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    }));

  return [
    {
      name: 'iphone-16-pro',
      browser: 'webkit',
      viewport: { width: 402, height: 874 },
      screen: { width: 402, height: 874 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    },
    {
      name: 'iphone-16-pro-short',
      browser: 'webkit',
      viewport: { width: 402, height: 650 },
      screen: { width: 402, height: 874 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    },
    ...widthProfiles,
  ];
}


export function validateConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object') {
    throw new Error('responsive config requires a non-empty root or server');
  }
  const hasRoot = typeof rawConfig.root === 'string' && Boolean(rawConfig.root.trim());
  const hasServer = rawConfig.server && typeof rawConfig.server === 'object';
  if (!hasRoot && !hasServer) {
    throw new Error('responsive config requires a non-empty root or server');
  }
  if (hasServer) {
    if (!Array.isArray(rawConfig.server.command) || rawConfig.server.command.length === 0) {
      throw new Error('responsive server command must be a non-empty array');
    }
    if (typeof rawConfig.server.url !== 'string' || !rawConfig.server.url.startsWith('http')) {
      throw new Error('responsive server requires an http URL');
    }
    const serverHost = new URL(rawConfig.server.url).hostname.replace(/^\[|\]$/g, '');
    if (serverHost !== 'localhost' && !['127.0.0.1', '::1'].includes(serverHost)) {
      throw new Error('responsive server URL must use a loopback host');
    }
  }
  if (rawConfig.setup !== undefined && (
    !Array.isArray(rawConfig.setup) || rawConfig.setup.length === 0
  )) {
    throw new Error('responsive setup command must be a non-empty array');
  }
  if (!Array.isArray(rawConfig.routes) || rawConfig.routes.length === 0) {
    throw new Error('responsive config requires at least one route');
  }
  for (const route of rawConfig.routes) {
    if (typeof route !== 'string' || !route.startsWith('/')) {
      throw new Error(`responsive routes must start with /: ${String(route)}`);
    }
  }
  if (rawConfig.readySelectors !== undefined) {
    if (
      !rawConfig.readySelectors || typeof rawConfig.readySelectors !== 'object' ||
      Array.isArray(rawConfig.readySelectors)
    ) {
      throw new Error('responsive readySelectors must be a route-to-selector object');
    }
    for (const [route, selector] of Object.entries(rawConfig.readySelectors)) {
      if (!rawConfig.routes.includes(route)) {
        throw new Error(`responsive ready selector uses an unknown route: ${route}`);
      }
      if (typeof selector !== 'string' || !selector.trim()) {
        throw new Error(`responsive ready selector must be a non-empty string: ${route}`);
      }
    }
  }
  if (rawConfig.readyTimeoutMs !== undefined && (
    !Number.isInteger(rawConfig.readyTimeoutMs) || rawConfig.readyTimeoutMs <= 0
  )) {
    throw new Error('responsive readyTimeoutMs must be a positive integer');
  }

  return {
    ...rawConfig,
    routes: [...new Set(rawConfig.routes)],
  };
}


export function resolveSitePath(siteRoot, requestPath) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath.split('?')[0]);
  } catch {
    throw new Error(`invalid URL encoding: ${requestPath}`);
  }

  const relativePath = decodedPath.replace(/^\/+/, '');
  let candidate = resolve(siteRoot, relativePath);
  if (!relativePath || decodedPath.endsWith('/')) {
    candidate = resolve(candidate, 'index.html');
  }

  const relation = relative(resolve(siteRoot), candidate);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`request resolves outside site root: ${requestPath}`);
  }
  const hiddenSegment = relativePath
    .split('/')
    .some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..');
  if (hiddenSegment) throw new Error(`request uses a hidden path: ${requestPath}`);
  if (existsSync(siteRoot) && existsSync(candidate)) {
    const realRoot = realpathSync(siteRoot);
    const realRelation = relative(realRoot, realpathSync(candidate));
    if (realRelation === '..' || realRelation.startsWith(`..${sep}`) || isAbsolute(realRelation)) {
      throw new Error(`request resolves outside site root through a symlink: ${requestPath}`);
    }
    if (realRelation.split(sep).some((segment) => segment.startsWith('.'))) {
      throw new Error(`request resolves through a hidden path: ${requestPath}`);
    }
  }
  return candidate;
}


function createStaticSite(siteRoot, spa) {
  return createServer((request, response) => {
    let filePath;
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      filePath = resolveSitePath(siteRoot, requestUrl.pathname);
    } catch (error) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(String(error.message));
      return;
    }

    if ((!existsSync(filePath) || !statSync(filePath).isFile()) && spa) {
      filePath = resolveSitePath(siteRoot, '/index.html');
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    });
    createReadStream(filePath).pipe(response);
  });
}


async function fillWorstCaseText(page) {
  const fields = page.locator([
    'input:not([type])',
    'input[type="email"]',
    'input[type="search"]',
    'input[type="tel"]',
    'input[type="text"]',
    'input[type="url"]',
    'textarea',
  ].join(','));

  for (let index = 0; index < await fields.count(); index += 1) {
    const field = fields.nth(index);
    if (!await field.isVisible().catch(() => false)) continue;
    if (await field.isDisabled().catch(() => true)) continue;
    if (await field.getAttribute('readonly') !== null) continue;

    const type = await field.getAttribute('type');
    const value = type === 'email'
      ? 'responsive-layout-regression-check@example.com'
      : type === 'url'
        ? 'https://example.com/a/very/long/mobile-layout-check'
        : type === 'tel'
          ? '+886-912-345-678 ext 123456789'
          : LONG_TEXT;
    await field.fill(value).catch(() => {});
    await field.blur().catch(() => {});
  }
}


async function collectViolations(page, ignoreSelectors = []) {
  return page.evaluate((selectors) => {
    const viewportWidth = document.documentElement.clientWidth;
    const rootOverflow = Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth ?? 0,
    ) - viewportWidth;
    const ignored = (element) => selectors.some((selector) => {
      try {
        return Boolean(element.closest(selector));
      } catch {
        return false;
      }
    });
    const insideHorizontalScroller = (element) => {
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (
          (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
          ancestor.scrollWidth > ancestor.clientWidth + 1
        ) return true;
      }
      return false;
    };
    const visibleOutside = (element) => {
      if (ignored(element) || insideHorizontalScroller(element)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 &&
        style.display !== 'none' && style.visibility !== 'hidden';
      return visible && (rect.left < -1 || rect.right > viewportWidth + 1);
    };
    const describe = (element) => ({
      element: element.outerHTML.slice(0, 180),
      left: Math.round(element.getBoundingClientRect().left),
      right: Math.round(element.getBoundingClientRect().right),
      viewportWidth,
    });
    const controls = [...document.querySelectorAll(
      'input, select, textarea, button, [role="button"]',
    )]
      .filter((element) => {
        if (element.closest('[aria-hidden="true"], [data-responsive-overflow-ok]')) return false;
        return visibleOutside(element);
      })
      .map(describe);
    const elements = rootOverflow > 1
      ? [...document.querySelectorAll('body *')]
        .filter(visibleOutside)
        .slice(0, 12)
        .map(describe)
      : [];

    return {
      rootOverflow: Math.max(0, Math.round(rootOverflow)),
      controls,
      elements,
    };
  }, ignoreSelectors);
}


function executeCommand(command, cwd) {
  const [executable, ...args] = command;
  const result = spawnSync(executable, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`setup command failed with exit ${result.status}: ${command.join(' ')}`);
  }
}


export async function waitForServer(url, child, timeoutMs, fetchImpl = fetch) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before becoming ready: ${child.exitCode}`);
    }
    try {
      const requestTimeout = Math.max(1, Math.min(1_000, deadline - Date.now()));
      const response = await fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(requestTimeout),
      });
      if (response.status < 500) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        if (child.exitCode !== null) {
          throw new Error(`server exited during readiness stabilization: ${child.exitCode}`);
        }
        return;
      }
    } catch {
      // The server is still starting.
    }
    const pause = Math.max(0, Math.min(250, deadline - Date.now()));
    if (pause > 0) await new Promise((resolveWait) => setTimeout(resolveWait, pause));
  }
  throw new Error(`server did not become ready within ${timeoutMs}ms: ${url}`);
}


export async function assertServerPortAvailable(rawUrl, timeoutMs = 500) {
  const url = new URL(rawUrl);
  const configuredHost = url.hostname.replace(/^\[|\]$/g, '');
  const hosts = configuredHost === 'localhost'
    ? ['127.0.0.1', '::1']
    : [configuredHost];
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  for (const host of hosts) {
    if (!isIP(host)) throw new Error(`responsive server host did not resolve to loopback: ${host}`);
    await new Promise((resolveAvailable, rejectUnavailable) => {
      const socket = createConnection({ host, port });
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) rejectUnavailable(error);
        else resolveAvailable();
      };
      socket.setTimeout(timeoutMs, () => finish(new Error(
        `could not verify responsive server port availability: ${host}:${port}`,
      )));
      socket.once('connect', () => finish(new Error(
        `responsive server port is already in use: ${host}:${port}`,
      )));
      socket.once('error', (error) => {
        if (['ECONNREFUSED', 'EAFNOSUPPORT', 'EADDRNOTAVAIL', 'ENETUNREACH'].includes(error.code)) {
          finish();
        } else {
          finish(error);
        }
      });
    });
  }
}


export function terminateWindowsProcessTree(child, spawnImpl = spawnSync) {
  const result = spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
    stdio: 'ignore',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    throw new Error(
      `taskkill failed with exit ${String(result.status)}${detail ? `: ${detail}` : ''}`,
    );
  }
}


async function stopServerProcess(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    terminateWindowsProcessTree(child, (command, args) => spawnSync(command, args, {
      stdio: 'ignore',
      encoding: 'utf8',
    }));
    return;
  }
  const signalGroup = (signal) => {
    process.kill(-child.pid, signal);
  };
  try {
    signalGroup('SIGTERM');
  } catch {
    return;
  }
  await new Promise((resolveExit) => {
    const timer = setTimeout(resolveExit, 1_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
  if (child.exitCode === null) {
    try {
      signalGroup('SIGKILL');
    } catch {
      // The process exited between the status check and signal.
    }
  }
}


export async function cleanupResources(browsers, staticServer, serverProcess) {
  const errors = [];
  const browserResults = await Promise.allSettled(
    Object.values(browsers).map((browser) => browser.close()),
  );
  for (const result of browserResults) {
    if (result.status === 'rejected') errors.push(result.reason);
  }
  if (staticServer) {
    try {
      await new Promise((resolveClose, rejectClose) => staticServer.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      }));
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await stopServerProcess(serverProcess);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      errors.map((error) => String(error?.message ?? error)).join('; '),
    );
  }
}


async function waitForRouteReady(page, route, config) {
  const timeout = config.readyTimeoutMs ?? 10_000;
  await page.waitForLoadState('load', { timeout });
  const selector = config.readySelectors?.[route];
  if (selector) await page.locator(selector).waitFor({ state: 'visible', timeout });
  await page.evaluate(() => new Promise((resolveReady) => {
    requestAnimationFrame(() => requestAnimationFrame(resolveReady));
  }));
}


function artifactName(route, profile) {
  const routeName = route === '/'
    ? 'root'
    : route.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return `${routeName || 'root'}--${profile.name}.png`;
}


export async function runCheck(playwright, config, configPath) {
  const repoRoot = dirname(configPath);
  let staticServer;
  let serverProcess;
  let baseUrl;
  const artifactsDir = process.env.RESPONSIVE_ARTIFACTS_DIR
    ? resolve(repoRoot, process.env.RESPONSIVE_ARTIFACTS_DIR)
    : resolve(tmpdir(), 'howt-responsive-guard', basename(repoRoot));
  const failures = [];
  const browsers = {};

  try {
    if (config.setup) executeCommand(config.setup, repoRoot);
    if (config.server) {
      await assertServerPortAvailable(config.server.url);
      const [executable, ...args] = config.server.command;
      serverProcess = spawn(executable, args, {
        cwd: repoRoot,
        detached: process.platform !== 'win32',
        env: process.env,
        stdio: 'inherit',
      });
      await waitForServer(
        config.server.url,
        serverProcess,
        config.server.readyTimeoutMs ?? 60_000,
      );
      baseUrl = config.server.url.replace(/\/+$/, '');
    } else {
      const siteRoot = resolve(repoRoot, config.root);
      const relation = relative(repoRoot, siteRoot);
      if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
        throw new Error('responsive config root must stay inside the repository');
      }
      if (!existsSync(siteRoot) || !statSync(siteRoot).isDirectory()) {
        throw new Error(`responsive site root does not exist: ${siteRoot}`);
      }
      const realRelation = relative(realpathSync(repoRoot), realpathSync(siteRoot));
      if (
        realRelation === '..' || realRelation.startsWith(`..${sep}`) ||
        isAbsolute(realRelation)
      ) {
        throw new Error('responsive config root must stay inside the repository after symlinks');
      }
      staticServer = createStaticSite(siteRoot, Boolean(config.spa));
      await new Promise((resolveListen, rejectListen) => {
        staticServer.once('error', rejectListen);
        staticServer.listen(0, '127.0.0.1', resolveListen);
      });
      const address = staticServer.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
    }

    for (const profile of buildProfiles()) {
      browsers[profile.browser] ??= await playwright[profile.browser].launch({ headless: true });
      const context = await browsers[profile.browser].newContext({
        viewport: profile.viewport,
        screen: profile.screen,
        deviceScaleFactor: profile.deviceScaleFactor,
        isMobile: profile.isMobile,
        hasTouch: profile.hasTouch,
      });
      const page = await context.newPage();
      page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));

      for (const route of config.routes) {
        try {
          const response = await page.goto(`${baseUrl}${route}`, {
            waitUntil: 'domcontentloaded',
            timeout: 15_000,
          });
          if (!response?.ok()) throw new Error(`HTTP ${response?.status() ?? 'unknown'}`);
          await waitForRouteReady(page, route, config);

          const initial = await collectViolations(page, config.ignoreSelectors ?? []);
          await fillWorstCaseText(page);
          await page.evaluate(() => new Promise((resolveReady) => {
            requestAnimationFrame(() => requestAnimationFrame(resolveReady));
          }));
          const worstCase = await collectViolations(page, config.ignoreSelectors ?? []);
          if (
            initial.rootOverflow > 1 || initial.controls.length > 0 ||
            worstCase.rootOverflow > 1 || worstCase.controls.length > 0
          ) {
            await mkdir(artifactsDir, { recursive: true });
            const screenshot = resolve(artifactsDir, artifactName(route, profile));
            await page.screenshot({ path: screenshot, fullPage: true });
            failures.push({ route, profile: profile.name, initial, worstCase, screenshot });
          }
        } catch (error) {
          failures.push({ route, profile: profile.name, error: String(error.message ?? error) });
        }
      }
      await context.close();
    }
  } finally {
    await cleanupResources(browsers, staticServer, serverProcess);
  }

  if (failures.length > 0) {
    console.error(JSON.stringify({ ok: false, failures }, null, 2));
    return 1;
  }
  console.log(JSON.stringify({
    ok: true,
    routes: config.routes.length,
    profiles: buildProfiles().length,
    checks: config.routes.length * buildProfiles().length,
  }));
  return 0;
}


async function main() {
  const configFlag = process.argv.indexOf('--config');
  const rawPath = configFlag >= 0 ? process.argv[configFlag + 1] : '.responsive-guard.json';
  if (!rawPath) throw new Error('--config requires a path');
  const configPath = resolve(process.cwd(), rawPath);
  const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')));
  const playwright = await import('playwright');
  process.exitCode = await runCheck(playwright, config, configPath);
}


const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
