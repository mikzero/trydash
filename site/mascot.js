// Inari Bash, the fox in the bottom-right corner. The section under the middle of
// the screen (any element with data-mascot) is the current one: when it changes
// and stays put for a moment she says its line for a few seconds. In the footer
// she keeps saying goodbye. A click (or tap) repeats the current line.
(function () {
  var mascot = document.getElementById('mascot');
  var bubble = document.getElementById('bubble');
  var button = document.getElementById('mascot-btn');
  if (!mascot || !bubble || !button) return;

  var SHOW_MS = 4500;
  var SETTLE_MS = 250; // ignore sections that only fly by while scrolling
  var sections = Array.prototype.slice.call(document.querySelectorAll('[data-mascot]'));
  var footer = document.querySelector('footer[data-mascot]');

  var current = null; // the section she last spoke about
  var hideTimer = 0;
  var settleTimer = 0;
  var frame = 0;
  var ready = Date.now() + 1400; // after she has peeked in (see .mascot in site.css)

  function line(section) {
    // The download line only holds when detect.js found the visitor's system.
    if (section.id === 'download' && !document.querySelector('.files tr.mine')) {
      return 'Scegli il file per il tuo sistema qui sotto.';
    }
    return section.dataset.mascot;
  }

  function hide() {
    clearTimeout(hideTimer);
    bubble.classList.remove('show');
  }

  function say(section) {
    clearTimeout(hideTimer);
    bubble.textContent = line(section);
    bubble.classList.add('show');
    mascot.classList.remove('hop');
    mascot.getBoundingClientRect();
    mascot.classList.add('hop');
    if (section !== footer) hideTimer = setTimeout(hide, SHOW_MS);
  }

  // The footer wins once half of it (or of the screen) is visible, or at the very
  // bottom of the page; otherwise the section that crosses the middle line.
  function active() {
    var h = window.innerHeight;
    if (footer) {
      var f = footer.getBoundingClientRect();
      var atBottom = window.scrollY + h >= document.documentElement.scrollHeight - 2;
      if (atBottom || h - f.top >= Math.min(f.height, h) * 0.5) return footer;
    }
    var middle = h / 2;
    for (var i = 0; i < sections.length; i += 1) {
      var r = sections[i].getBoundingClientRect();
      if (sections[i] !== footer && r.top <= middle && r.bottom > middle) return sections[i];
    }
    return null;
  }

  function update() {
    frame = 0;
    var next = active();
    clearTimeout(settleTimer);
    if (next === current) return;
    // Leaving the footer: its goodbye must not linger over the page.
    if (current === footer) hide();
    settleTimer = setTimeout(function () {
      if (active() !== next) return;
      current = next;
      if (next) say(next);
      else hide();
    }, Math.max(SETTLE_MS, ready - Date.now()));
  }

  function schedule() {
    if (!frame) frame = window.requestAnimationFrame(update);
  }

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  schedule();

  button.addEventListener('click', function () {
    if (bubble.classList.contains('show') && current !== footer) {
      hide();
      return;
    }
    say(current || active() || sections[0]);
  });
})();
