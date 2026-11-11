/*! Pulseboard feedback widget
 * <script src="https://HOST/widget.js" data-workspace="your-slug" async></script>
 * Optional: data-label="Feedback" data-position="right|left" data-color="#5b5bd6"
 */
(function () {
  'use strict';
  var script = document.currentScript ||
    document.querySelector('script[src*="widget.js"][data-workspace]');
  if (!script) return;
  var slug = script.getAttribute('data-workspace');
  if (!slug || !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) {
    console.warn('[pulseboard] data-workspace missing or invalid');
    return;
  }
  var origin;
  try { origin = new URL(script.src, location.href).origin; } catch (e) { return; }
  var label = script.getAttribute('data-label') || 'Feedback';
  var left = script.getAttribute('data-position') === 'left';
  var color = script.getAttribute('data-color');
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) color = '#5b5bd6';

  function mount() {
    if (document.getElementById('pulseboard-widget')) return;
    var host = document.createElement('div');
    host.id = 'pulseboard-widget';
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

    var style = document.createElement('style');
    style.textContent =
      ':host{all:initial}' +
      'a{position:fixed;bottom:20px;' + (left ? 'left' : 'right') + ':20px;z-index:2147483000;' +
      'display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:999px;' +
      'background:' + color + ';color:#fff;font:600 14px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
      'text-decoration:none;box-shadow:0 4px 18px rgba(0,0,0,.18);transition:transform .15s}' +
      'a:hover{transform:translateY(-2px)}' +
      'a:focus-visible{outline:3px solid #fff;outline-offset:2px}' +
      'svg{width:16px;height:16px}' +
      '@media (prefers-reduced-motion:reduce){a{transition:none}}';

    var a = document.createElement('a');
    a.href = origin + '/' + slug;
    a.target = '_blank';
    a.rel = 'noopener';
    a.setAttribute('aria-label', label + ' (öffnet in neuem Tab)');
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M4 4h16v12H8l-4 4z');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    a.appendChild(svg);
    a.appendChild(document.createTextNode(label));

    root.appendChild(style);
    root.appendChild(a);
    document.body.appendChild(host);
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
