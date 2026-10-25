// What the Tauri app gives the page, as the Electron app's preload (desktop/src/preload.ts) does:
// `window.NexlibrisDesktop` (client/src/backends/desktopBridge.ts), answered by main.rs. Only the
// app's own page gets it, never a frame inside it (a book's content).
(() => {
  if (window.top !== window || location.protocol !== 'app:') return;
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  let menuHandler;
  let fullScreenHandler;
  // How main.rs reaches the page: a menu item chosen, the window in or out of full screen.
  Object.defineProperty(window, '__nexlibris', {
    value: Object.freeze({
      menu: (id) => menuHandler?.(id),
      fullScreen: (on) => fullScreenHandler?.(on),
    }),
  });
  const mac = /Mac/.test(navigator.platform);
  window.NexlibrisDesktop = Object.freeze({
    rpc: (request) => invoke('rpc', { request }),
    setMenu: (menus) => void invoke('set_menu', { menus }),
    onMenuCommand: (handler) => {
      menuHandler = handler;
    },
    // On macOS the window has no title bar: the page's top bar holds the window buttons.
    titleBarInset: mac,
    onFullScreen: (handler) => {
      fullScreenHandler = handler;
    },
    setFullScreen: (on) => void invoke('set_full_screen', { on }),
  });
  // A book's window (`?read=`, client/src/library/readerWindow.ts) is opened by the app, as a window
  // of its own; see `open_reader` in main.rs. The page only checks that one opened, and focuses it.
  const open = window.open.bind(window);
  window.open = (url, target, features) => {
    const address = new URL(url ?? '', location.href);
    if (address.origin !== location.origin || !address.searchParams.has('read')) return open(url, target, features);
    void invoke('open_reader', { url: address.href, name: target ?? '' });
    return { closed: false, focus() {}, close() {} };
  };
  if (!mac) return;

  // The system's web view (WebKit) has no `-webkit-app-region`, which marks where the Electron app's
  // window is moved from, so the same places are found here: the library's top bar
  // (`data-window-drag`), the strip above a reader (`[data-covers-window]`, `--title-bar-height`
  // high) and epubier's toolbar, leaving out what can be clicked in them.
  const CLICKABLE = 'button, a, input, select, textarea, label, summary, [role="button"], [contenteditable], .ep-panel, .ep-scrim, .ep-selection-menu';
  const dragsWindow = (target, y) => {
    const root = document.documentElement;
    if (root.dataset.titleBar !== 'inset' || target.closest(CLICKABLE)) return false;
    if (target.closest('.epubier.ep-title-bar .ep-toolbar')) return true;
    if (document.querySelector('dialog[open]')) return false;
    if (document.querySelector('[data-covers-window]')) {
      const strip = parseFloat(getComputedStyle(root).getPropertyValue('--title-bar-height')) || 0;
      return !!target.closest('[data-covers-window]') && y < strip;
    }
    return !!target.closest('[data-window-drag]');
  };
  document.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || !(event.target instanceof Element) || !dragsWindow(event.target, event.clientY)) return;
    event.preventDefault();
    void invoke(event.detail === 2 ? 'toggle_zoom' : 'start_dragging');
  });
})();
