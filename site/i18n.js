// Texts the scripts write into the page, in the page's language (<html lang>).
// The pages themselves are translated in index.html (English) and it/index.html.
//
//   trydashT('detected', { name: 'Linux x64' })  -> "detected Linux x64."
(function (global) {
  var TEXTS = {
    en: {
      yourSystem: 'your system',
      versionBadge: 'Version {v} · free software',
      download: 'Download trydash',
      downloadVersion: 'Download trydash {v}',
      downloadFor: 'Download for {name}',
      pickBefore: 'For Linux, macOS and Windows: pick the file in the ',
      pickLink: 'Download section',
      pickAfter: '.',
      versionDot: 'Version {v} · ',
      detected: 'detected {name}. ',
      macIntel: 'Mac with an Intel processor? ',
      pickMacIntel: 'Pick macOS Intel',
      otherSystems: 'Other systems',
      starting: 'starting',
      startingChip: 'STARTING',
      waitingUrl: 'waiting for the URL…',
      live: 'live',
      liveChip: 'LIVE',
      pickYourFile: 'Pick the file for your system below.',
    },
    it: {
      yourSystem: 'il tuo sistema',
      versionBadge: 'Versione {v} · software libero',
      download: 'Scarica trydash',
      downloadVersion: 'Scarica trydash {v}',
      downloadFor: 'Scarica per {name}',
      pickBefore: 'Per Linux, macOS e Windows: scegli il file nella ',
      pickLink: 'sezione Download',
      pickAfter: '.',
      versionDot: 'Versione {v} · ',
      detected: 'rilevato {name}. ',
      macIntel: 'Mac con processore Intel? ',
      pickMacIntel: 'Scegli macOS Intel',
      otherSystems: 'Altri sistemi',
      starting: 'in avvio',
      startingChip: 'IN AVVIO',
      waitingUrl: 'in attesa dell’URL…',
      live: 'attivo',
      liveChip: 'ATTIVO',
      pickYourFile: 'Scegli il file per il tuo sistema qui sotto.',
    },
  };

  var lang = String(document.documentElement.lang || 'en').slice(0, 2);
  var texts = TEXTS[lang] || TEXTS.en;

  global.trydashLang = TEXTS[lang] ? lang : 'en';
  global.trydashTexts = TEXTS;
  global.trydashT = function (key, vars) {
    return String(texts[key] || TEXTS.en[key] || key).replace(/\{(\w+)\}/g, function (_, name) {
      return vars && name in vars ? vars[name] : '';
    });
  };
})(window);
