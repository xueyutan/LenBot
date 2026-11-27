'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lenbot', {
  startService: () => ipcRenderer.invoke('lenbot:start-service'),
  stopService: () => ipcRenderer.invoke('lenbot:stop-service'),
  retry: () => ipcRenderer.invoke('lenbot:retry'),
  openLog: () => ipcRenderer.invoke('lenbot:open-log'),
  openConsole: () => ipcRenderer.invoke('lenbot:open-console'),
  consoleSnapshot: () => ipcRenderer.invoke('lenbot:console-snapshot'),
  onConsole: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('lenbot:console', handler);
    return () => ipcRenderer.removeListener('lenbot:console', handler);
  },
  getPrefs: () => ipcRenderer.invoke('lenbot:get-prefs'),
  setPrefs: (patch) => ipcRenderer.invoke('lenbot:set-prefs', patch),
  getStatus: () => ipcRenderer.invoke('lenbot:get-status'),
  startSnowLuma: () => ipcRenderer.invoke('lenbot:start-snowluma'),
  stopSnowLuma: () => ipcRenderer.invoke('lenbot:stop-snowluma'),
  openSnowLumaLog: () => ipcRenderer.invoke('lenbot:open-snowluma-log'),
  onServices: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('lenbot:services', handler);
    return () => ipcRenderer.removeListener('lenbot:services', handler);
  },
  onProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('lenbot:progress', handler);
    return () => ipcRenderer.removeListener('lenbot:progress', handler);
  },
  onWebuiPassword: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('lenbot:webui-password', handler);
    return () => ipcRenderer.removeListener('lenbot:webui-password', handler);
  },
});

// 面板页右下角挂一个「服务控制台」入口，替代原来常驻的两个黑窗口。
function mountConsoleButton() {
  if (location.pathname.endsWith('console.html')) return;
  if (!document.body || document.getElementById('lenbot-console-fab')) return;
  const button = document.createElement('button');
  button.id = 'lenbot-console-fab';
  button.type = 'button';
  button.textContent = '服务控制台';
  button.title = '查看 LenBot / SnowLuma 的运行日志';
  Object.assign(button.style, {
    position: 'fixed',
    right: '14px',
    bottom: '58px',
    zIndex: '2147483000',
    padding: '6px 12px',
    borderRadius: '999px',
    border: '1px solid rgba(255,255,255,.18)',
    background: 'rgba(22,18,24,.72)',
    color: '#f4e7ee',
    font: '12px/1.2 system-ui, "Microsoft YaHei", sans-serif',
    cursor: 'pointer',
    opacity: '.5',
    transition: 'opacity .15s ease, background .15s ease',
  });
  button.addEventListener('mouseenter', () => {
    button.style.opacity = '1';
    button.style.background = 'rgba(58,42,51,.92)';
  });
  button.addEventListener('mouseleave', () => {
    button.style.opacity = '.5';
    button.style.background = 'rgba(22,18,24,.72)';
  });
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    try {
      // preload 跑在隔离世界，看不到自己经 contextBridge 暴露到主世界的 window.lenbot，
      // 所以这里直接用 ipcRenderer 调用，不绕那一层。
      const result = await ipcRenderer.invoke('lenbot:open-console');
      if (result && result.ok === false) throw new Error(result.error || '未知错误');
    } catch (error) {
      const reason = String((error && error.message) || error).slice(0, 60);
      button.textContent = '打开失败：' + reason;
      button.style.background = 'rgba(122,26,38,.92)';
      button.style.opacity = '1';
      setTimeout(() => {
        button.textContent = '服务控制台';
        button.style.background = 'rgba(22,18,24,.72)';
        button.style.opacity = '.5';
      }, 6000);
    }
  });
  document.body.appendChild(button);
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', mountConsoleButton);
} else {
  mountConsoleButton();
}
