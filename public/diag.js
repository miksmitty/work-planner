// Startup diagnostics (plain ES5 so it runs even where the main app cannot).
// Shows a visible banner instead of a silently dead page.
(function () {
  function banner(msg) {
    var el = document.getElementById('diag-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'diag-banner';
      el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#b3261e;color:#fff;font:13px/1.4 Arial,sans-serif;padding:10px 14px;white-space:pre-wrap;max-height:40vh;overflow:auto';
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent += (el.textContent ? '\n' : '') + msg;
  }
  window.__diag = banner;
  window.addEventListener('error', function (e) {
    banner('Work Planner error: ' + (e.message || 'script failed to load') + (e.filename ? '\n  at ' + e.filename.split('/').pop() + ':' + e.lineno : ''));
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    banner('Work Planner error: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
  });
  window.setTimeout(function () {
    if (!window.__appStarted) {
      banner('Work Planner did not start. Its script was blocked, failed to load, or this browser is too old (needs a current Chrome, Edge, Firefox or Safari). Check the browser console and any security policy that blocks scripts.');
    }
  }, 3000);
})();
