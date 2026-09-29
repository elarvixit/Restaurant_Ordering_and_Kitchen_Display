'use strict';
// Light/dark theme switch. Loaded in <head> (not deferred) so the saved theme is applied
// before first paint. Each screen remembers its own choice: a kitchen tablet can stay dark
// while the customer screen is light. With no saved choice, a screen follows the page's
// default (the kitchen defaults to dark) or else the device's system setting.
(function () {
  var root = document.documentElement;
  var page = location.pathname.replace(/^\/+|\.html$/g, '') || 'home';
  var key = 'theme:' + page;

  var saved = null;
  try { saved = localStorage.getItem(key); } catch (e) {}
  if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);

  function current() {
    var t = root.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') return t;
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // The button names the theme you'll switch TO.
  function paint(btn) {
    var dark = current() === 'dark';
    btn.innerHTML = (dark ? '☀️' : '🌙') + '<span class="theme-label">' + (dark ? 'Light' : 'Dark') + '</span>';
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    btn.title = btn.getAttribute('aria-label');
  }

  function toggle() {
    var next = current() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem(key, next); } catch (e) {}
    document.querySelectorAll('[data-theme-toggle]').forEach(paint);
  }

  function bind(btn) {
    if (btn.dataset.themeBound) return;
    btn.dataset.themeBound = '1';
    paint(btn);
    btn.addEventListener('click', toggle);
  }

  window.Theme = { toggle: toggle, bind: bind, current: current };
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-theme-toggle]').forEach(bind);
  });
  // Keep the button label right when the system theme changes and no choice is saved.
  if (window.matchMedia) {
    var mq = matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () { document.querySelectorAll('[data-theme-toggle]').forEach(paint); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
  }
})();
