// Inari Bash, the fox in the bottom-right corner. The section under the middle of
// the screen (any element with data-mascot) is the current one: when it changes
// and stays put for a moment she says its line, typed out, for a few seconds.
// In the footer she keeps waving goodbye. A click (or tap) repeats the line.
//
// She is one picture, so she moves as a whole, on stacked layers (site.css):
// - she leans with the scroll speed and springs back, and turns a little
//   towards the pointer;
// - a mood per section (data-mascot-mood): "party" throws confetti, "wave" waves;
// - a tap makes her wiggle with a few hearts;
// - after a while without scrolling she dozes off with "z"s, and wakes with a start.
// With prefers-reduced-motion only the bubble is left.
(function () {
  var mascot = document.getElementById('mascot');
  var bubble = document.getElementById('bubble');
  var button = document.getElementById('mascot-btn');
  var fx = document.getElementById('fx');
  var lean = mascot && mascot.querySelector('.fox-lean');
  if (!mascot || !bubble || !button) return;

  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var SHOW_MS = 4500;
  var SETTLE_MS = 250; // ignore sections that only fly by while scrolling
  var TYPE_MS = 22;
  var NAP_MS = 25000;
  var MOODS = ['hop', 'party', 'wave', 'wiggle', 'sleepy', 'startle'];
  var sections = Array.prototype.slice.call(document.querySelectorAll('[data-mascot]'));
  var footer = document.querySelector('footer[data-mascot]');

  var current = null; // the section she last spoke about
  var hideTimer = 0;
  var settleTimer = 0;
  var typeTimer = 0;
  var napTimer = 0;
  var frame = 0;
  var ready = Date.now() + 1500; // after she has peeked in (see .mascot in site.css)

  function line(section) {
    // The download line only holds when detect.js found the visitor's system.
    if (section.id === 'download' && !document.querySelector('.files tr.mine')) {
      return window.trydashT('pickYourFile');
    }
    return section.dataset.mascot;
  }

  // Restarts a one-shot mood animation even when it is the same as the last one.
  function mood(name) {
    if (calm) return;
    MOODS.forEach(function (m) { if (m !== 'wave') mascot.classList.remove(m); });
    if (!name) return;
    void mascot.offsetWidth;
    mascot.classList.add(name);
  }

  function particles(kind, count) {
    if (calm || !fx) return;
    var colors = ['#c2410c', '#fb923c', '#16a34a', '#0369a1', '#ca8a04', '#db2777'];
    for (var i = 0; i < count; i += 1) {
      var p = document.createElement('span');
      p.className = kind;
      if (kind === 'confetti') {
        var angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
        var dist = 55 + Math.random() * 45;
        p.style.setProperty('--dx', Math.round(Math.cos(angle) * dist) + 'px');
        p.style.setProperty('--dy', Math.round(Math.sin(angle) * dist - 30) + 'px');
        p.style.setProperty('--rot', Math.round(Math.random() * 720 - 360) + 'deg');
        p.style.background = colors[i % colors.length];
      } else {
        p.textContent = kind === 'heart' ? '♥' : 'z';
        p.style.color = kind === 'heart' ? colors[(i * 2 + 5) % colors.length] : '';
        p.style.setProperty('--dx', Math.round((i - (count - 1) / 2) * 16 + Math.random() * 8) + 'px');
        p.style.animationDelay = (kind === 'zzz' ? i * 0.7 : i * 0.12) + 's';
        p.style.fontSize = kind === 'zzz' ? (0.7 + i * 0.2) + 'rem' : '';
      }
      fx.appendChild(p);
      p.addEventListener('animationend', function () { this.remove(); });
    }
  }

  function hide() {
    clearTimeout(hideTimer);
    clearTimeout(typeTimer);
    bubble.classList.remove('show');
  }

  // The full line sizes the bubble; the typed copy grows over it.
  function type(text) {
    clearTimeout(typeTimer);
    bubble.textContent = '';
    bubble.classList.remove('done');
    if (calm) {
      bubble.textContent = text;
      bubble.classList.add('done');
      return;
    }
    var sizer = document.createElement('span');
    sizer.className = 'sizer';
    sizer.textContent = text;
    var typed = document.createElement('span');
    typed.className = 'typed';
    bubble.append(sizer, typed);
    var shown = 0;
    (function next() {
      shown += 1;
      typed.textContent = text.slice(0, shown);
      if (shown < text.length) typeTimer = setTimeout(next, TYPE_MS);
      else bubble.classList.add('done');
    })();
  }

  function say(section) {
    clearTimeout(hideTimer);
    type(line(section));
    bubble.classList.add('show');
    var wanted = section.dataset.mascotMood;
    mascot.classList.toggle('wave', wanted === 'wave' && !calm);
    if (wanted === 'party') {
      mood('party');
      setTimeout(function () { particles('confetti', 14); }, 350);
    } else if (wanted !== 'wave') {
      mood('hop');
    }
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
    if (current === footer) {
      hide();
      mascot.classList.remove('wave');
    }
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

  // ---- Lean: a damped spring towards the scroll speed and the pointer side.
  var angle = 0;
  var speed = 0;
  var target = 0;
  var look = 0;
  var lastY = window.scrollY;
  var lastT = 0;
  var springing = 0;

  function spring(now) {
    springing = 0;
    var dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 0.016);
    lastT = now;
    // The scroll push fades by itself, so she straightens up when scrolling stops.
    target *= Math.pow(0.02, dt);
    var goal = target + look;
    speed += ((goal - angle) * 140 - speed * 14) * dt;
    angle += speed * dt;
    if (lean) lean.style.setProperty('--lean', angle.toFixed(2) + 'deg');
    if (Math.abs(goal - angle) > 0.05 || Math.abs(speed) > 0.05 || Math.abs(target) > 0.05) {
      springing = window.requestAnimationFrame(spring);
    } else {
      lastT = 0;
    }
  }

  function kick() {
    if (!calm && !springing) springing = window.requestAnimationFrame(spring);
  }

  function onScroll() {
    var y = window.scrollY;
    // Scrolling down leans her back, scrolling up forward, up to 12 degrees.
    target = Math.max(-12, Math.min(12, target + (y - lastY) * -0.08));
    lastY = y;
    kick();
    wake();
    schedule();
  }

  function onPointer(event) {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    var box = button.getBoundingClientRect();
    var dx = event.clientX - (box.left + box.width / 2);
    // Within half a screen she turns up to 5 degrees towards the pointer.
    look = Math.max(-5, Math.min(5, dx / (window.innerWidth / 2) * 5));
    kick();
    wake();
  }

  // ---- Naps: after a while with nothing happening.
  function wake() {
    clearTimeout(napTimer);
    if (mascot.classList.contains('sleepy')) {
      mascot.classList.remove('sleepy');
      mood('startle');
    }
    if (!calm) napTimer = setTimeout(nap, NAP_MS);
  }

  function nap() {
    if (document.hidden || current === footer) {
      napTimer = setTimeout(nap, NAP_MS);
      return;
    }
    hide();
    mood('sleepy');
    particles('zzz', 3);
    napTimer = setInterval(function () {
      if (mascot.classList.contains('sleepy')) particles('zzz', 3);
    }, 2600);
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', schedule);
  window.addEventListener('pointermove', onPointer, { passive: true });
  window.addEventListener('keydown', wake);
  schedule();
  wake();

  button.addEventListener('pointerenter', function () {
    if (!mascot.classList.contains('sleepy')) mood('wiggle');
  });

  button.addEventListener('click', function () {
    clearInterval(napTimer);
    var wasAsleep = mascot.classList.contains('sleepy');
    wake();
    if (!wasAsleep) {
      mood('wiggle');
      particles('heart', 3);
    }
    if (bubble.classList.contains('show') && current !== footer) {
      hide();
      return;
    }
    say(current || active() || sections[0]);
  });
})();
