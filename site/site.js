// Suggests the download for the visitor's system (see detect.js). The download
// links are direct links to the release files, also without JavaScript.
(function () {
  var REPO = 'mikzero/trydash';
  var LABELS = {
    'linux-x64': 'Linux x64',
    'linux-arm64': 'Linux ARM64',
    'darwin-arm64': 'macOS Apple Silicon',
    'darwin-x64': 'macOS Intel',
    'windows-x64.exe': 'Windows x64',
  };

  // The page ships with direct links to the current release; the GitHub API, when
  // it answers, moves them to a newer one.
  var current = document.querySelector('.v');
  var release = { version: current ? current.textContent : '', files: {} };
  var choice = null;

  function el(tag, text, attrs) {
    var node = document.createElement(tag);
    if (text) node.textContent = text;
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    return node;
  }

  // The big button and the hint under it follow the detected system; the table row
  // for that system is marked. Called again when the release data arrives.
  function render() {
    var version = release.version;
    var button = document.getElementById('primary-download');
    var label = document.getElementById('primary-label');
    var hint = document.getElementById('primary-hint');

    document.querySelectorAll('.v').forEach(function (node) { if (version) node.textContent = version; });
    document.querySelectorAll('a[data-suffix]').forEach(function (a) {
      var url = release.files['trydash-' + version + '-' + a.dataset.suffix];
      if (url) a.href = url;
      var row = a.closest('tr');
      var mine = Boolean(choice && choice.suffix === a.dataset.suffix);
      row.classList.toggle('mine', mine);
      var badge = row.querySelector('.mine-badge');
      if (mine && !badge) row.cells[0].appendChild(el('span', 'il tuo sistema', { class: 'mine-badge' }));
      if (!mine && badge) badge.remove();
    });
    document.querySelectorAll('a[data-file]').forEach(function (a) {
      if (release.files[a.dataset.file]) a.href = release.files[a.dataset.file];
    });
    if (version) document.getElementById('eyebrow-text').textContent = 'Versione ' + version + ' · software libero';

    hint.textContent = '';
    if (!choice) {
      button.href = '#download';
      label.textContent = version ? 'Scarica trydash ' + version : 'Scarica trydash';
      hint.append('Per Linux, macOS e Windows: scegli il file nella ', el('a', 'sezione Download', { href: '#download' }), '.');
      return;
    }
    var name = LABELS[choice.suffix];
    button.href = document.querySelector('a[data-suffix="' + choice.suffix + '"]').href;
    label.textContent = 'Scarica per ' + name;
    hint.append((version ? 'Versione ' + version + ' · ' : '') + 'rilevato ' + name + '. ');
    if (!choice.certain && choice.suffix === 'darwin-arm64') hint.append('Mac con processore Intel? ', el('a', 'Scegli macOS Intel', { href: '#download' }));
    else hint.append(el('a', 'Altri sistemi', { href: '#download' }));
  }

  if (window.trydashDetect) {
    window.trydashDetect.collect().then(function (info) {
      choice = window.trydashDetect.pick(info);
      render();
    }, function () {});
  }

  function apply(data) {
    release.version = String(data.tag_name || '').replace(/^v/, '');
    (data.assets || []).forEach(function (asset) { release.files[asset.name] = asset.browser_download_url; });
    render();
  }

  // Fade sections in as they scroll into view (the hidden state only exists with JS).
  var reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        observer.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -10% 0px' });
    reveals.forEach(function (node) { observer.observe(node); });
  } else {
    reveals.forEach(function (node) { node.classList.add('in'); });
  }

  fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (release) { if (release) apply(release); })
    .catch(function () {});
})();
