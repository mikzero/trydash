// Points the download links at the files of the latest release and suggests the
// one for the visitor's system. Without JavaScript or the GitHub API, every link
// still opens the latest release page.
(function () {
  var REPO = 'mikzero/trydash';
  var LABELS = {
    'linux-x64': 'Linux x64',
    'linux-arm64': 'Linux ARM64',
    'darwin-arm64': 'macOS Apple Silicon',
    'darwin-x64': 'macOS Intel',
    'windows-x64.exe': 'Windows x64',
  };

  // Browsers do not say whether a Mac is Intel or Apple Silicon: default to the latter.
  function guessSuffix() {
    var ua = navigator.userAgent;
    var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'windows-x64.exe';
    if (/Mac/i.test(platform) || /Mac OS X/i.test(ua)) return /iPhone|iPad/i.test(ua) ? null : 'darwin-arm64';
    if (/Android/i.test(ua)) return null;
    if (/Linux/i.test(platform) || /Linux/i.test(ua)) return /aarch64|arm64/i.test(platform + ua) ? 'linux-arm64' : 'linux-x64';
    return null;
  }

  function apply(release) {
    var version = String(release.tag_name || '').replace(/^v/, '');
    var byName = {};
    (release.assets || []).forEach(function (asset) { byName[asset.name] = asset.browser_download_url; });

    document.querySelectorAll('.v').forEach(function (el) { el.textContent = version; });
    document.querySelectorAll('a[data-suffix]').forEach(function (a) {
      var url = byName['trydash-' + version + '-' + a.dataset.suffix];
      if (url) a.href = url;
    });
    document.querySelectorAll('a[data-file]').forEach(function (a) {
      if (byName[a.dataset.file]) a.href = byName[a.dataset.file];
    });

    var suffix = guessSuffix();
    var url = suffix && byName['trydash-' + version + '-' + suffix];
    var button = document.getElementById('primary-download');
    var label = document.getElementById('primary-label');
    var hint = document.getElementById('primary-hint');
    if (version) document.getElementById('eyebrow-text').textContent = 'Versione ' + version + ' · software libero';
    if (url) {
      button.href = url;
      label.textContent = 'Scarica per ' + LABELS[suffix];
      hint.textContent = 'Versione ' + version + '. Altri sistemi più sotto, nella sezione Download.';
    } else if (version) {
      button.href = '#download';
      label.textContent = 'Scarica trydash ' + version;
    }
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
