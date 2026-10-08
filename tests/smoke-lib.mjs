// Общее для сценариев smoke*.mjs: темы, ширины и скрипт, который выполняется в странице до её кода.
export const VIEWPORTS = [{ width: 360, height: 800 }, { width: 1280, height: 800 }];
export const SCHEMES = ['light', 'dark'];

// Тема в приложении хранится в localStorage (ключ theme), флаг welcome=1 прячет окно приветствия; нарушения CSP копятся в window.__csp.
export const SETUP = (s) => {
  try { localStorage.setItem('theme', s); localStorage.setItem('welcome', '1'); } catch { /* нет доступа */ }
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
};
