// Guesses which trydash build fits the visitor's computer.
//
//   trydashDetect.pick(info)  -> { suffix, certain } or null (phone, tablet, unknown)
//   trydashDetect.collect()   -> Promise of the info pick() needs, read from the browser
//
// Browsers rarely tell the CPU: Chromium does through userAgentData, elsewhere the
// GPU name tells an Intel Mac from an Apple Silicon one.
(function (global) {
  function pick(info) {
    var ua = info.ua || '';
    var platform = info.platform || '';
    var arch = String(info.arch || '').toLowerCase();
    var gpu = info.gpu || '';
    var mac = /Mac/i.test(platform) || /Macintosh|Mac OS X/i.test(ua);

    if (info.mobile || /iPhone|iPad|iPod|Android/i.test(ua)) return null;
    // iPadOS asks for the desktop site and calls itself a Mac, but has a touch screen.
    if (mac && info.touch > 1) return null;

    if (/Win/i.test(platform) || /Windows/i.test(ua)) return { suffix: 'windows-x64.exe', certain: true };
    if (mac) {
      if (arch) return { suffix: arch === 'arm' ? 'darwin-arm64' : 'darwin-x64', certain: true };
      if (/Apple M\d|Apple GPU/i.test(gpu)) return { suffix: 'darwin-arm64', certain: true };
      if (/Intel|AMD|Radeon|NVIDIA/i.test(gpu)) return { suffix: 'darwin-x64', certain: true };
      return { suffix: 'darwin-arm64', certain: false };
    }
    if (/Linux|X11|CrOS/i.test(platform + ' ' + ua)) {
      if (arch) return { suffix: arch === 'arm' ? 'linux-arm64' : 'linux-x64', certain: true };
      var arm = /aarch64|arm64|armv8/i.test(platform + ' ' + ua);
      return { suffix: arm ? 'linux-arm64' : 'linux-x64', certain: arm || /x86_64|x64|amd64/i.test(platform + ' ' + ua) };
    }
    return null;
  }

  function gpuName() {
    try {
      var gl = document.createElement('canvas').getContext('webgl');
      var ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    } catch (e) {
      return '';
    }
  }

  function collect() {
    var nav = global.navigator;
    var data = nav.userAgentData;
    var info = {
      ua: nav.userAgent,
      platform: (data && data.platform) || nav.platform || '',
      mobile: Boolean(data && data.mobile),
      touch: nav.maxTouchPoints || 0,
      arch: '',
      gpu: '',
    };
    var high = data && data.getHighEntropyValues
      ? data.getHighEntropyValues(['architecture']).then(function (v) { info.arch = v.architecture || ''; }, function () {})
      : Promise.resolve();
    return high.then(function () {
      if (!info.arch && /Mac/i.test(info.platform + info.ua)) info.gpu = gpuName();
      return info;
    });
  }

  global.trydashDetect = { pick: pick, collect: collect };
})(window);
