// Inari Bash, the trydash fox, in the bottom-right corner. When a section with
// data-mascot reaches the middle of the screen she says its line for a few
// seconds; in the footer she keeps saying goodbye. A click (or tap) repeats the
// current line.
(function () {
  var mascot = document.getElementById('mascot');
  var bubble = document.getElementById('bubble');
  var button = document.getElementById('mascot-btn');
  if (!mascot || !bubble || !button) return;

  var SHOW_MS = 4500;
  var current = null;
  var timer = 0;
  var ready = Date.now() + 1400; // after she has peeked in (see .mascot in site.css)

  function line(section) {
    // The download line only holds when detect.js found the visitor's system.
    if (section.id === 'download' && !document.querySelector('.files tr.mine')) {
      return 'Scegli il file per il tuo sistema qui sotto.';
    }
    return section.dataset.mascot;
  }

  function say(section, keep) {
    clearTimeout(timer);
    var wait = ready - Date.now();
    if (wait > 0) { timer = setTimeout(function () { say(section, keep); }, wait); return; }
    bubble.textContent = line(section);
    bubble.classList.add('show');
    mascot.classList.remove('hop');
    mascot.getBoundingClientRect();
    mascot.classList.add('hop');
    if (!keep) timer = setTimeout(function () { bubble.classList.remove('show'); }, SHOW_MS);
  }

  var sections = Array.prototype.slice.call(document.querySelectorAll('[data-mascot]'));
  var footer = document.querySelector('footer[data-mascot]');

  if ('IntersectionObserver' in window) {
    // A section is "current" when it crosses the middle band of the viewport; the
    // footer counts as soon as it shows up, since it may never reach the middle,
    // and wins over the section above it while it is on screen.
    var middle = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting || e.target === current || current === footer) return;
        current = e.target;
        say(current, false);
      });
    }, { rootMargin: '-45% 0px -45% 0px' });
    sections.forEach(function (s) { if (s !== footer) middle.observe(s); });

    if (footer) {
      new IntersectionObserver(function (entries) {
        var e = entries[0];
        if (e.isIntersecting && current !== footer) {
          current = footer;
          say(footer, true);
        } else if (!e.isIntersecting && current === footer) {
          current = null;
          bubble.classList.remove('show');
        }
      }, { threshold: 0.4 }).observe(footer);
    }
  }

  button.addEventListener('click', function () {
    if (bubble.classList.contains('show') && current !== footer) {
      clearTimeout(timer);
      bubble.classList.remove('show');
      return;
    }
    say(current || sections[0], current === footer);
  });
})();
