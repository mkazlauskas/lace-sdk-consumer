import type { Page } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';

// Explicitly opt-in, Chromium/Vite development only. Breakpoints observe the
// existing package; no source rewriting, logger replacement or wallet access.
const anchors = [
  ['imports-complete', 'const walletState = await firstValueFrom(store.get('],
  ['storage-read-complete', 'const indexerClientConnection = {'],
  ['keys-ready', 'const dustParameters = ledger.LedgerParameters.initialParameters().dust;'],
  ['facade-ready', 'walletFacade = facade;'],
  ['unshielded-started', 'syncStartSubscription = keysWithAuthCancelledRecovery$'],
  ['account-watch-failed', 'dependencies.logger.error("Account watch failure:", error);'],
] as const;

// Evaluated INSIDE the paused catch/observer. Only enums and locations in known static
// script URLs may leave the browser. Never return message, stack, cause, args,
// object descriptions, account identifiers, scopes or wallet/key material.
export function summarizeStartupError(error: unknown, scriptUrls: string[]) {
  const names = ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'RuntimeError', 'AbortError', 'MidnightAccountNotFoundError', 'MidnightWalletNotReadyError'];
  const result: { kind: string; category: string; locations: { source: number; line: number; column: number }[] } = { kind: 'unknown', category: 'unclassified', locations: [] };
  try {
    if (!error || typeof error !== 'object') return result;
    const name = (error as Error).name;
    result.kind = names.includes(name) ? name : 'other';
    const message = (error as Error).message;
    if (name === 'MidnightAccountNotFoundError') result.category = 'account-not-found';
    else if (name === 'MidnightWalletNotReadyError') result.category = 'wallet-not-ready';
    else if (typeof message === 'string') {
      if (/expected instance of/i.test(message)) result.category = 'wasm-instance-mismatch';
      else if (/is not a function|is not a constructor/i.test(message)) result.category = 'missing-callable';
      else if (/undefined|null/i.test(message)) result.category = 'missing-value';
      else if (/fetch|network|websocket/i.test(message)) result.category = 'transport';
      else if (/decrypt|authentication/i.test(message)) result.category = 'authentication';
    }
    const stack = (error as Error).stack;
    if (typeof stack === 'string') {
      for (const row of stack.split('\n').slice(1, 30)) {
        for (const [source, url] of scriptUrls.entries()) {
          const start = row.indexOf(url + ':');
          if (start < 0) continue;
          const position = /^(\d+):(\d+)/.exec(row.slice(start + url.length + 1));
          if (position) result.locations.push({ source, line: Number(position[1]), column: Number(position[2]) });
          if (result.locations.length >= 8) return result;
        }
      }
    }
  } catch { /* Unknown/custom error getters never escape this boundary. */ }
  return result;
}

export async function installStartupDiagnostics(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const stages: string[] = [];
  const failures: (ReturnType<typeof summarizeStartupError> & { stage: string })[] = [];
  const scripts: string[] = [];
  const points = new Map<string, string>();
  const resolved = new Set<string>();
  let stopped = false;
  let armed = false;
  let balanceObserverArmed = false;
  let appScriptId: string | undefined;
  let diagnosticError = false;
  let budgetExpired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    await cdp.detach().catch(() => { diagnosticError = true; });
  };
  cdp.on('Debugger.scriptParsed', event => {
    // These are known, loaded, local package scripts, not error-supplied paths.
    try {
      const url = new URL(event.url);
      if (['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/src/midnight/app.ts') appScriptId = event.scriptId;
      if (['localhost', '127.0.0.1'].includes(url.hostname) && /^\/node_modules\/[\w@./-]+\.js$/.test(url.pathname) && scripts.length < 500 && !scripts.includes(event.url)) scripts.push(event.url);
    } catch { /* ignore eval/wasm and non-package scripts */ }
  });
  cdp.on('Debugger.breakpointResolved', event => {
    const stage = points.get(event.breakpointId);
    if (stage) resolved.add(stage);
  });
  cdp.on('Debugger.paused', async event => {
    try {
      const stage = (event.hitBreakpoints ?? []).map((id: string) => points.get(id)).find(Boolean);
      if (stage && stages.length < 40) stages.push(stage);
      if ((stage === 'account-watch-failed' || stage === 'balance-stream-failed') && failures.length < 3) {
        const response = await cdp.send('Debugger.evaluateOnCallFrame', {
          callFrameId: event.callFrames[0].callFrameId,
          expression: `(${summarizeStartupError.toString()})(error, ${JSON.stringify(scripts)})`,
          returnByValue: true, silent: true,
        });
        if (response.exceptionDetails || !response.result.value) diagnosticError = true;
        else failures.push({ ...response.result.value, stage });
      }
    } catch { diagnosticError = true; }
    finally { await cdp.send('Debugger.resume').catch(() => { diagnosticError = true; }); }
  });
  try {
    await cdp.send('Debugger.enable');
    // The reviewed dev runtime was already optimized. Refuse stale/unavailable
    // anchors instead of claiming diagnostic coverage over a different bundle.
    // The engine's startup and its account watcher live in the SDK's sdk-init
    // or watch chunk; each anchor must match exactly one line across them.
    const names = (await readdir('node_modules/.vite/deps')).filter(name => /^[\w@.-]+\.js$/.test(name));
    const chunks = await Promise.all(names.map(async name => [name, (await readFile(`node_modules/.vite/deps/${name}`, 'utf8')).split('\n')] as const));
    if (chunks.length === 0) throw new Error('Diagnostic bundle unavailable');
    for (const [stage, anchor] of anchors) {
      const matches = chunks.flatMap(([name, lines]) => lines.flatMap((line, index) => line.includes(anchor) ? [{ name, index }] : []));
      if (matches.length !== 1) throw new Error('Diagnostic anchor unavailable');
      const { breakpointId } = await cdp.send('Debugger.setBreakpointByUrl', {
        urlRegex: `/node_modules/\\.vite/deps/${matches[0].name.replaceAll('.', '\\.')}([?]|$)`,
        lineNumber: matches[0].index,
      });
      points.set(breakpointId, stage);
    }
    armed = true;
    // Cover the SDK's 120-second registry timeout plus preflight/restore.
    // Public terminal failures still abort immediately; this only bounds CDP.
    timer = setTimeout(() => { budgetExpired = true; void stop(); }, 180_000);
  } catch {
    await stop();
    throw new Error('Startup diagnostic anchors unavailable. Run the existing dev runtime probe first; no wallet input was loaded.');
  }
  return {
    stop,
    // Call after the app loads and BEFORE wallet input. Read Vite's executed
    // source: TypeScript source line numbers are not browser line numbers.
    armBalanceObserver: async () => {
      let reason = 'app-script-unavailable';
      try {
        if (stopped || !appScriptId) throw new Error('Diagnostic app unavailable');
        reason = 'script-source-unavailable';
        const { scriptSource } = await cdp.send('Debugger.getScriptSource', { scriptId: appScriptId });
        reason = 'observer-anchor-unavailable';
        const matches = scriptSource.split('\n').flatMap((line: string, index: number) => line.trim() === 'observed.balanceStreamFailed = true;' ? [index] : []);
        if (matches.length !== 1) throw new Error('Diagnostic observer anchor unavailable');
        reason = 'observer-breakpoint-unavailable';
        const { breakpointId, locations } = await cdp.send('Debugger.setBreakpointByUrl', {
          urlRegex: '^https?://(localhost|127\\.0\\.0\\.1)(:[0-9]+)?/src/midnight/app\\.ts([?]|$)',
          lineNumber: matches[0],
        });
        points.set(breakpointId, 'balance-stream-failed');
        reason = 'observer-breakpoint-unresolved';
        if (!locations.some(location => location.scriptId === appScriptId && location.lineNumber === matches[0])) throw new Error('Diagnostic observer breakpoint unresolved');
        resolved.add('balance-stream-failed');
        balanceObserverArmed = true;
      } catch {
        diagnosticError = true;
        await stop();
        throw new Error(`Balance diagnostic ${reason}; wallet input must not be loaded.`);
      }
    },
    snapshot: () => ({ armed, balanceObserverArmed, resolved: [...resolved], stages, diagnosticError, budgetExpired,
      failures: failures.map(failure => ({ ...failure, locations: failure.locations.map(({ source, line, column }) => ({ file: new URL(scripts[source]).pathname, line, column })) })),
    }),
  };
}
