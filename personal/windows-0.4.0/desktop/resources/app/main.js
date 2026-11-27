'use strict';
// LenBot 控制台 —— 本机 Electron 桌面客户端
// 设计约束：所有自身数据（userData / 日志 / 崩溃转储 / 窗口状态）都写在本应用目录内，
// 不往桌面、开始菜单、注册表或用户目录放任何东西。
// 联动：先拉起 SnowLuma 协议端（3001），确认监听后再拉起 LenBot（8088），避免平台连接被拒。

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { spawn, execFile } = require('child_process');

const APP_DIR = path.dirname(process.execPath);
const DATA_DIR = path.join(APP_DIR, 'userdata');
const SRC_DIR = __dirname;
const LENBOT_ROOT = path.resolve(APP_DIR, '..', 'lenbot-0.4.0-windows-x64');
const SL_DIR = path.resolve(APP_DIR, '..', 'SnowLuma-v2.1.1-win-x64');
const PYTHON = path.join(LENBOT_ROOT, 'releases', '0.4.0', 'python', 'python.exe');
const SL_NODE = path.join(SL_DIR, 'node.exe');
const SL_ENTRY = path.join(SL_DIR, 'index.mjs');
const PANEL_URL = 'http://127.0.0.1:8088/';
const ONEBOT_WS_PORT = 3001;
const ICON_ICO = path.join(SRC_DIR, 'icon.ico');
const ICON_PNG = path.join(SRC_DIR, 'icon.png');
const SERVICE_LOG = path.join(DATA_DIR, 'lenbot-service.log');
const SL_LOG = path.join(DATA_DIR, 'snowluma-service.log');
const APP_LOG = path.join(DATA_DIR, 'app.log');
const PID_FILE = path.join(DATA_DIR, 'lenbot-service.pid');
const SL_PID_FILE = path.join(DATA_DIR, 'snowluma-service.pid');
const PREFS_FILE = path.join(DATA_DIR, 'prefs.json');
const STATE_FILE = path.join(DATA_DIR, 'window-state.json');
const SELFTEST_SHOW = process.argv.includes('--selftest-show');

// 3001 建立监听要几秒，两次启动请求挨得太近时旧的检查看不到端口，会各自 spawn 一份，
// 两份协议端抢同一个 QQ 的注入通道，结果谁都不监听 3001。用标记挡住这个窗口期。
let snowLumaStarting = false;
const SELFTEST_LINK = process.argv.includes('--selftest-link');
const SELFTEST = process.argv.includes('--selftest') || SELFTEST_SHOW || SELFTEST_LINK;

fs.mkdirSync(DATA_DIR, { recursive: true });
app.setPath('userData', DATA_DIR);
try { app.setPath('logs', path.join(DATA_DIR, 'logs')); } catch { /* 老版本 Electron 忽略 */ }
try { app.setPath('crashDumps', path.join(DATA_DIR, 'crashDumps')); } catch { /* 同上 */ }

let win = null;
let tray = null;
let quitting = false;
let mode = 'loading';
let lastLoadingKey = '';
let pollTimer = null;
let fastPoll = false;

function log(line) {
  try {
    fs.appendFileSync(APP_LOG, '[' + new Date().toISOString() + '] ' + line + '\n');
  } catch { /* 日志失败不影响运行 */ }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  try { fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); } catch { /* 忽略 */ }
}

function prefs() {
  const p = readJson(PREFS_FILE, {});
  return { autoStart: !!p.autoStart, closeToTray: p.closeToTray !== false };
}

// 面板只要能返回 HTTP 状态（哪怕是登录页 401）就算服务在线
function panelOnline(timeout = 1200) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      const req = http.get(PANEL_URL, (res) => { res.resume(); finish(true); });
      req.setTimeout(timeout, () => { req.destroy(); finish(false); });
      req.on('error', () => finish(false));
    } catch { finish(false); }
  });
}

// TCP 握手成功即视为端口有人监听（不依赖 HTTP/WebSocket 协议响应）
function portOpen(port, timeout = 700) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const sock = new net.Socket();
    sock.setTimeout(timeout);
    sock.once('connect', () => { sock.destroy(); finish(true); });
    sock.once('timeout', () => { sock.destroy(); finish(false); });
    sock.once('error', () => { sock.destroy(); finish(false); });
    try { sock.connect(port, '127.0.0.1'); } catch { finish(false); }
  });
}

function snowlumaOnline() { return portOpen(ONEBOT_WS_PORT); }

async function waitFor(check, tries = 45, interval = 1000) {
  for (let i = 0; i < tries; i += 1) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

function sendProgress(text) {
  if (win && !win.isDestroyed()) win.webContents.send('lenbot:progress', { text });
}

function sendServices(snowluma, panel) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('lenbot:services', { snowluma: !!snowluma, panel: !!panel });
  }
}

// 全新实例第一次启动 SnowLuma 会生成一串随机 WebUI 初始密码，
// 只打印到协议端 stdout（本软件重定向到 snowluma-service.log），不落配置明文。
function findWebuiPassword() {
  try {
    // 初始密码一旦被改过就作废，日志里的旧串不能再显示，否则会误导登录
    const authPath = path.join(SL_DIR, 'config', 'webui.json');
    if (fs.existsSync(authPath)) {
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      if (auth.mustChangePassword === false) return null;
    }
  } catch {
    // 配置读不到时仍按日志判断
  }
  try {
    if (!fs.existsSync(SL_LOG)) return null;
    const tail = fs.readFileSync(SL_LOG, 'utf8').split(/\r?\n/).slice(-600).join('\n');
    const found = [...tail.matchAll(/initial credentials:\s*user=admin\s+password=([0-9a-f]{16})/gi)];
    return found.length ? found[found.length - 1][1] : null;
  } catch {
    return null;
  }
}

function sendWebuiPassword() {
  if (!win || win.isDestroyed()) return;
  const password = findWebuiPassword();
  if (password) win.webContents.send('lenbot:webui-password', { password });
}

function windowBounds() {
  const saved = readJson(STATE_FILE, null);
  const fallback = { width: 1360, height: 900, maximized: false };
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return fallback;
  const width = Math.max(960, Math.round(saved.width));
  const height = Math.max(640, Math.round(saved.height));
  let displays = [];
  try { displays = screen.getAllDisplays(); } catch { /* 忽略 */ }
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const visible = displays.some((d) => {
      const a = d.workArea;
      return saved.x < a.x + a.width && saved.x + width > a.x
        && saved.y < a.y + a.height && saved.y + height > a.y;
    });
    if (visible) {
      return { x: Math.round(saved.x), y: Math.round(saved.y), width, height, maximized: !!saved.maximized };
    }
  }
  return { width, height, maximized: !!saved.maximized };
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try { writeJson(STATE_FILE, { ...win.getBounds(), maximized: win.isMaximized() }); } catch { /* 忽略 */ }
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  else showWindow();
}

function openLoading(status, detail) {
  if (!win || win.isDestroyed()) return;
  const key = status + '|' + (detail || '');
  if (mode === 'loading' && lastLoadingKey === key) return;
  lastLoadingKey = key;
  mode = 'loading';
  win.loadFile(path.join(SRC_DIR, 'loading.html'), { query: { status, detail: detail || '' } })
    .catch((e) => log('loadFile 失败: ' + (e && e.message ? e.message : String(e))));
}

function openPanel() {
  if (!win || win.isDestroyed()) return;
  mode = 'panel';
  lastLoadingKey = '';
  win.loadURL(PANEL_URL).catch((e) => log('loadURL 失败: ' + (e && e.message ? e.message : String(e))));
}

// 首次配置时 LenBot 不用 8088，而是监听随机端口并把带 token 的链接打印到服务日志。
function findSetupUrl() {
  try {
    if (!fs.existsSync(SERVICE_LOG)) return null;
    const tail = fs.readFileSync(SERVICE_LOG, 'utf8').split(/\r?\n/).slice(-400).join('\n');
    const found = [...tail.matchAll(/尚无根配置。请打开 (http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_\-]+)/g)];
    return found.length ? found[found.length - 1][1] : null;
  } catch {
    return null;
  }
}

function openSetup(url) {
  if (!win || win.isDestroyed() || !url) return;
  mode = 'setup';
  lastLoadingKey = '';
  win.loadURL(url).catch((e) => log('打开首次配置失败: ' + (e && e.message ? e.message : String(e))));
  log('已打开首次配置向导');
}

async function refresh() {
  const online = await panelOnline();
  const sl = await snowlumaOnline();
  if (!win || win.isDestroyed()) return;
  sendServices(sl, online);
  if (online) {
    if (mode !== 'panel') { log('面板在线，切换到面板页面'); openPanel(); }
    if (fastPoll) startPolling(false);
  } else if (mode === 'setup') {
    // 首次配置向导进行中：8088 还没上线是正常的，不要把它拉回离线页
    if (!findSetupUrl()) { mode = 'loading'; openLoading('offline', 'LenBot 服务未运行'); }
  } else {
    const setupUrl = findSetupUrl();
    if (setupUrl) openSetup(setupUrl);
    else if (mode !== 'loading' || !win.webContents.getURL().startsWith('file:')) {
      openLoading('offline', 'LenBot 服务未运行');
    }
  }
  updateTrayMenu();
  sendWebuiPassword();
}

function startPolling(fast) {
  if (pollTimer) clearInterval(pollTimer);
  fastPoll = !!fast;
  pollTimer = setInterval(refresh, fast ? 800 : 2500);
  refresh();
}

function createWindow() {
  const b = windowBounds();
  const opts = {
    width: b.width,
    height: b.height,
    minWidth: 960,
    minHeight: 640,
    title: 'LenBot 控制台',
    icon: ICON_ICO,
    backgroundColor: '#f7f3f6',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(SRC_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };
  if (Number.isFinite(b.x)) { opts.x = b.x; opts.y = b.y; }
  win = new BrowserWindow(opts);
  Menu.setApplicationMenu(null);
  if (b.maximized) win.maximize();

  if (!SELFTEST || SELFTEST_SHOW) win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
  win.on('close', (event) => {
    saveWindowState();
    if (!quitting && prefs().closeToTray) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-fail-load', (_event, _code, _desc, url) => {
    if (String(url).startsWith(PANEL_URL)) openLoading('offline', '面板连接中断，请检查 LenBot 服务');
  });

  refresh();
}

function startSnowLuma() {
  if (snowLumaStarting) {
    log('SnowLuma 正在启动中，忽略重复启动请求');
    return { ok: false, error: '协议端正在启动中，稍等几秒' };
  }
  snowLumaStarting = true;
  setTimeout(() => { snowLumaStarting = false; }, 25000);
  try {
    if (!fs.existsSync(SL_NODE) || !fs.existsSync(SL_ENTRY)) {
      return { ok: false, error: '找不到 SnowLuma 副本：' + SL_DIR };
    }
    const fd = fs.openSync(SL_LOG, 'a');
    const child = spawn(SL_NODE, [SL_ENTRY], {
      cwd: SL_DIR,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    try { fs.closeSync(fd); } catch { /* 忽略 */ }
    child.on('error', (e) => log('SnowLuma 进程错误: ' + e.message));
    child.unref();
    writeJson(SL_PID_FILE, { pid: child.pid, startedAt: Date.now() });
    log('已启动 SnowLuma pid=' + child.pid);
    updateTrayMenu();
    return { ok: true, pid: child.pid };
  } catch (e) {
    log('启动 SnowLuma 失败: ' + (e && e.message ? e.message : String(e)));
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function startService() {
  try {
    if (!fs.existsSync(PYTHON)) {
      return { ok: false, error: '找不到 LenBot Python 运行时：' + PYTHON };
    }
    const fd = fs.openSync(SERVICE_LOG, 'a');
    const child = spawn(PYTHON, ['-X', 'utf8', '-u', '-m', 'len_bot.next.launcher', LENBOT_ROOT], {
      cwd: LENBOT_ROOT,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    try { fs.closeSync(fd); } catch { /* 忽略 */ }
    child.on('error', (e) => log('服务进程错误: ' + e.message));
    child.unref();
    writeJson(PID_FILE, { pid: child.pid, startedAt: Date.now() });
    log('已启动 LenBot 服务 pid=' + child.pid);
    startPolling(true);
    updateTrayMenu();
    return { ok: true, pid: child.pid };
  } catch (e) {
    log('启动服务失败: ' + (e && e.message ? e.message : String(e)));
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// 联动核心：协议端先行，面板后行；已经在线的一律复用，避免重复启动 / 端口抢占
async function startAll() {
  const steps = [];
  if (await snowlumaOnline()) {
    steps.push('协议端 3001 已在监听，复用现有实例');
    sendProgress('协议端已在运行，检查 LenBot 面板…');
  } else {
    sendProgress('正在启动 SnowLuma 协议端（3001）…');
    const started = startSnowLuma();
    if (!started.ok) return { ok: false, error: started.error, steps };
    const up = await waitFor(snowlumaOnline);
    if (!up) {
      // 全新实例第一次没有 OneBot 配置，3001 本来就不会监听。
      // 不能因此放弃启动 LenBot，否则连首次配置向导都打不开。
      steps.push('协议端 3001 尚未监听（首次使用需先在 5099 配置 OneBot 正向 WebSocket）');
      sendProgress('协议端 3001 尚未就绪，仍继续启动 LenBot 以完成首次配置…');
      log('SnowLuma 3001 未就绪，继续启动 LenBot（首次配置场景）');
    } else {
      steps.push('SnowLuma 已监听 3001');
    }
  }

  if (await panelOnline()) {
    steps.push('LenBot 面板 8088 已在线');
  } else {
    sendProgress('协议端就绪，正在启动 LenBot 服务…');
    // 面板不在线时，可能还留着上一条僵死的 host 占着实例锁与 8088，先清干净再起
    await killStrayHosts();
    const started = startService();
    if (!started.ok) return { ok: false, error: started.error, steps };
    // 首次配置阶段没有 8088，只有随机端口的向导链接，两者都算「已就绪」
    const up = await waitFor(async () => (await panelOnline()) || !!findSetupUrl(), 40, 1000);
    if (!up) return { ok: false, steps, error: 'LenBot 启动超时：8088 未就绪，请查看服务日志' };
    if (await panelOnline()) {
      steps.push('LenBot 面板已就绪');
    } else {
      const setupUrl = findSetupUrl();
      steps.push('LenBot 已进入首次配置向导');
      openSetup(setupUrl);
    }
  }

  sendProgress('正在进入 LenBot…');
  refresh();
  log('联动启动完成: ' + steps.join(' | '));
  return { ok: true, steps };
}

function killRecorded(file, label) {
  const record = readJson(file, null);
  if (!record || !Number.isFinite(record.pid)) {
    return Promise.resolve({ ok: false, error: '没有由本软件启动的' + label + '记录' });
  }
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(record.pid), '/T', '/F'], { windowsHide: true }, (err) => {
      if (!err) { try { fs.rmSync(file, { force: true }); } catch { /* 忽略 */ } }
      log('停止' + label + ' pid=' + record.pid + (err ? ' 失败: ' + err.message : ' 成功'));
      updateTrayMenu();
      resolve(err ? { ok: false, error: err.message } : { ok: true });
    });
  });
}

// 兜底清理：PID 记录指的是 launcher，真正跑服务的是它派生的 host。只要 launcher 换过一轮
// （比如连点两次启动），记录就会过期，老 host 继续占着实例锁和 8088，新进程起不来。
// 这里按命令行把 len_bot 的 host / launcher 全清掉，不碰其它 python 进程。
function killStrayHosts() {
  const script = "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*len_bot.next.host*' -or $_.CommandLine -like '*len_bot.next.launcher*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true, timeout: 12000 }, (err) => {
        log(err ? '清理残留宿主进程出错: ' + err.message : '已清理残留宿主进程');
        resolve();
      });
  });
}

async function stopService() {
  const result = await killRecorded(PID_FILE, 'LenBot 服务');
  await killStrayHosts();
  try { fs.rmSync(PID_FILE, { force: true }); } catch { /* 忽略 */ }
  updateTrayMenu();
  return result.ok ? result : { ok: true, note: 'PID 记录已过期，按进程名清理了残留宿主' };
}
function stopSnowLuma() { return killRecorded(SL_PID_FILE, 'SnowLuma'); }

// ---- 重启：先停干净（taskkill /T 连子进程一起），等端口真的释放，再重新拉起 ----
function portListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* 忽略 */ }
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    setTimeout(() => finish(false), 600);
  });
}

async function waitPortFree(port, timeoutMs = 9000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portListening(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function restartService() {
  log('重启 LenBot 服务');
  await stopService();
  if (!(await waitPortFree(8088))) {
    log('重启 LenBot 服务失败: 8088 仍被占用，可能不是由本软件启动的服务');
    return { ok: false, error: '8088 仍被占用' };
  }
  const started = startService();
  if (!started.ok) log('重启 LenBot 服务失败: ' + started.error);
  return started;
}

async function restartSnowLuma() {
  log('重启 SnowLuma 协议端');
  await stopSnowLuma();
  if (!(await waitPortFree(3001))) {
    log('重启 SnowLuma 协议端失败: 3001 仍被占用，可能不是由本软件启动的实例');
    return { ok: false, error: '3001 仍被占用' };
  }
  const started = startSnowLuma();
  if (!started.ok) log('重启 SnowLuma 协议端失败: ' + started.error);
  return started;
}

async function restartAll() {
  log('重启整套服务');
  await stopService();
  await stopSnowLuma();
  await waitPortFree(8088);
  await waitPortFree(3001);
  const result = await startAll();
  if (!result.ok) log('重启整套服务失败: ' + result.error);
  return result;
}

function relaunchApp() {
  log('重启软件');
  quitting = true;
  saveWindowState();
  if (tray && !tray.isDestroyed()) tray.destroy();
  app.relaunch();
  app.exit(0);
}

function openLogFile(file) {
  if (!fs.existsSync(file)) { try { fs.writeFileSync(file, ''); } catch { /* 忽略 */ } }
  shell.showItemInFolder(file);
  return { ok: true };
}

// ---- 服务控制台：替代原来那两个常驻黑窗口 ----
let consoleWin = null;
let consoleTimer = null;

function tail(file, maxBytes) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return '';
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, length, start);
    fs.closeSync(fd);
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

function consolePayload() {
  const structured = tailJsonl(path.join(LENBOT_ROOT, 'instance', 'logs', 'lenbot.jsonl'), 200000, 500);
  const raw = tail(SERVICE_LOG, 20000).trim();
  const lenbot = structured
    ? structured + (raw ? '\n\n----- 启动器原始输出 -----\n' + raw : '')
    : raw;
  return { lenbot, snowluma: tail(SL_LOG, 20000) };
}

// 服务的结构化日志是 JSONL；转成一行一条的可读文本，和原来的黑窗口观感接近。
function tailJsonl(file, maxBytes, maxLines) {
  const text = tail(file, maxBytes);
  if (!text) return '';
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const rendered = [];
  for (const line of lines.slice(-maxLines)) {
    let item;
    try { item = JSON.parse(line); } catch { rendered.push(line); continue; }
    const time = typeof item.ts === 'string' ? item.ts.slice(11, 19) : '';
    const level = String(item.level || '').padEnd(5);
    const source = String(item.source || '');
    const message = String(item.message || '');
    const extra = [];
    for (const key of ['event', 'status', 'tool', 'error', 'reason']) {
      if (item[key] === undefined || item[key] === null) continue;
      const value = typeof item[key] === 'string' ? item[key] : JSON.stringify(item[key]);
      extra.push(key + '=' + value);
    }
    rendered.push(`${time} ${level} ${source} ${message}${extra.length ? '  ' + extra.join(' ') : ''}`);
  }
  return rendered.join('\n');
}

function showConsole() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) {
      consoleWin.show();
      consoleWin.focus();
      return { ok: true };
    }
    consoleWin = new BrowserWindow({
      width: 920,
      height: 560,
      minWidth: 560,
      minHeight: 320,
      title: 'LenBot 服务控制台',
      icon: ICON_ICO,
      backgroundColor: '#0c0c0c',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(SRC_DIR, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    log('打开服务控制台');
    consoleWin.loadFile(path.join(SRC_DIR, 'console.html')).catch((error) => {
      log('控制台页面加载失败: ' + (error && error.message ? error.message : String(error)));
    });
    consoleWin.webContents.on('did-finish-load', () => {
      if (consoleWin && !consoleWin.isDestroyed()) consoleWin.webContents.send('lenbot:console', consolePayload());
    });
    consoleWin.webContents.on('did-fail-load', (_event, code, description) => {
      log('控制台页面加载出错: ' + code + ' ' + description);
    });
    consoleWin.on('closed', () => {
      consoleWin = null;
      if (consoleTimer) { clearInterval(consoleTimer); consoleTimer = null; }
    });
    consoleTimer = setInterval(() => {
      if (!consoleWin || consoleWin.isDestroyed()) return;
      consoleWin.webContents.send('lenbot:console', consolePayload());
    }, 1200);
    return { ok: true };
  } catch (error) {
    log('打开服务控制台失败: ' + (error && error.stack ? error.stack : String(error)));
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const p = prefs();
  const hasLenbot = !!readJson(PID_FILE, null);
  const hasSl = !!readJson(SL_PID_FILE, null);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏 LenBot 控制台', click: toggleWindow },
    { label: '在系统浏览器中打开面板', click: () => shell.openExternal(PANEL_URL) },
    { type: 'separator' },
    {
      label: '一键启动（SnowLuma + LenBot）',
      click: () => { startAll().then((r) => { if (!r.ok) log('托盘联动失败: ' + r.error); }); },
    },
    { type: 'separator' },
    {
      label: '启动 SnowLuma 协议端',
      enabled: !hasSl,
      click: () => { const r = startSnowLuma(); if (!r.ok) log('托盘启动失败: ' + r.error); },
    },
    {
      label: '停止 SnowLuma 协议端',
      enabled: hasSl,
      click: () => { stopSnowLuma(); },
    },
    {
      label: '重启 SnowLuma 协议端',
      click: () => { restartSnowLuma(); },
    },
    { label: '查看协议端日志', click: () => openLogFile(SL_LOG) },
    { type: 'separator' },
    {
      label: '启动 LenBot 服务',
      enabled: !hasLenbot,
      click: () => { const r = startService(); if (!r.ok) log('托盘启动失败: ' + r.error); },
    },
    {
      label: '停止 LenBot 服务',
      enabled: hasLenbot,
      click: () => { stopService(); },
    },
    {
      label: '重启 LenBot 服务',
      click: () => { restartService(); },
    },
    { label: '打开服务控制台', click: () => showConsole() },
    { label: '在文件夹中显示服务日志', click: () => openLogFile(SERVICE_LOG) },
    { type: 'separator' },
    {
      label: '关闭窗口时最小化到托盘',
      type: 'checkbox',
      checked: p.closeToTray,
      click: (item) => {
        const next = prefs();
        next.closeToTray = item.checked;
        writeJson(PREFS_FILE, next);
      },
    },
    { type: 'separator' },
    { label: '重启软件（界面）', click: () => relaunchApp() },
    {
      label: '重启整套（SnowLuma + LenBot）',
      click: () => { restartAll(); },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        if (pollTimer) clearInterval(pollTimer);
        saveWindowState();
        if (tray && !tray.isDestroyed()) tray.destroy();
        app.quit();
      },
    },
  ]));
}

function createTray() {
  let image = nativeImage.createFromPath(ICON_PNG);
  if (image.isEmpty()) image = nativeImage.createFromPath(ICON_ICO);
  tray = new Tray(image.resize({ width: 20, height: 20 }));
  tray.setToolTip('LenBot 控制台');
  tray.on('click', () => toggleWindow());
  tray.on('double-click', () => showWindow());
  updateTrayMenu();
}

ipcMain.handle('lenbot:start-service', () => startAll());
ipcMain.handle('lenbot:stop-service', () => stopService());
ipcMain.handle('lenbot:start-snowluma', () => startSnowLuma());
ipcMain.handle('lenbot:stop-snowluma', () => stopSnowLuma());
ipcMain.handle('lenbot:open-snowluma-log', () => openLogFile(SL_LOG));
ipcMain.handle('lenbot:get-status', async () => ({
  snowluma: await snowlumaOnline(),
  panel: await panelOnline(),
}));
ipcMain.handle('lenbot:retry', () => { startPolling(true); return { ok: true }; });
ipcMain.handle('lenbot:open-log', () => openLogFile(SERVICE_LOG));
ipcMain.handle('lenbot:open-console', () => showConsole());
ipcMain.handle('lenbot:console-snapshot', () => consolePayload());
ipcMain.handle('lenbot:get-prefs', () => prefs());
ipcMain.handle('lenbot:set-prefs', (_event, patch) => {
  const next = { ...prefs(), ...(patch && typeof patch === 'object' ? patch : {}) };
  writeJson(PREFS_FILE, next);
  return next;
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('window-all-closed', () => { /* 关闭窗口只缩托盘，不退出进程 */ });
  app.on('before-quit', () => { quitting = true; });

  app.whenReady().then(async () => {
    log('启动 electron=' + process.versions.electron + ' node=' + process.versions.node + ' exe=' + process.execPath);
    createTray();
    createWindow();

    if (!SELFTEST && (prefs().autoStart || process.argv.includes('--start-all'))) {
      log('按偏好 / --start-all 联动启动 SnowLuma + LenBot');
      startAll();
    }
    startPolling();

    // 联动自检：真实拉起两个服务，写结果后退出窗口（服务保持运行）
    if (SELFTEST_LINK) {
      const result = await startAll();
      const slUp = await snowlumaOnline();
      const panelUp = await panelOnline();
      writeJson(path.join(DATA_DIR, 'linktest.json'), {
        ok: result.ok,
        error: result.error || null,
        steps: result.steps,
        snowlumaOnline: slUp,
        panelOnline: panelUp,
        slDir: SL_DIR,
        slPid: readJson(SL_PID_FILE, null),
        lenbotPid: readJson(PID_FILE, null),
        at: new Date().toISOString(),
      });
      quitting = true;
      if (pollTimer) clearInterval(pollTimer);
      app.exit(0);
      return;
    }

    if (SELFTEST) {
      const online = await panelOnline(800);
      setTimeout(async () => {
        const alive = !!(win && !win.isDestroyed());
        if (SELFTEST_SHOW && alive) {
          try {
            const image = await win.webContents.capturePage();
            fs.writeFileSync(path.join(DATA_DIR, 'selftest-screenshot.png'), image.toPNG());
          } catch (e) {
            log('截图失败: ' + (e && e.message ? e.message : String(e)));
          }
        }
        writeJson(path.join(DATA_DIR, 'selftest.json'), {
          ok: alive,
          electron: process.versions.electron,
          node: process.versions.node,
          exe: process.execPath,
          appDir: APP_DIR,
          userData: app.getPath('userData'),
          windowCreated: alive,
          windowTitle: alive ? win.getTitle() : null,
          currentUrl: alive ? win.webContents.getURL() : null,
          panelOnline: online,
          snowlumaOnline: await snowlumaOnline(),
          trayCreated: !!(tray && !tray.isDestroyed()),
          lenbotRoot: LENBOT_ROOT,
          pythonExists: fs.existsSync(PYTHON),
          slDir: SL_DIR,
          slNodeExists: fs.existsSync(SL_NODE),
          slEntryExists: fs.existsSync(SL_ENTRY),
        });
        quitting = true;
        if (pollTimer) clearInterval(pollTimer);
        app.exit(0);
      }, 2600);
    }
  }).catch((e) => log('启动失败: ' + (e && e.stack ? e.stack : String(e))));
}
