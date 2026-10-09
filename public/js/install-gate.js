(function (root) {
  'use strict';

  var api = root.TryDash || (root.TryDash = {});

  var INSTALL_ACTIONS = ['recheck'];
  var WORKSPACE_ACTIONS = ['create', 'stop', 'remove', 'select'];

  function assetName(platform, arch, kind) {
    var cpu = arch || 'x64';
    if (platform === 'darwin') {
      var mac = cpu === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
      return mac;
    }
    if (platform === 'win32') {
      return cpu === 'ia32' ? 'cloudflared-windows-386.exe' : 'cloudflared-windows-amd64.exe';
    }
    if (kind === 'deb') {
      if (cpu === 'arm64') return 'cloudflared-linux-arm64.deb';
      if (cpu === 'arm') return 'cloudflared-linux-arm.deb';
      if (cpu === 'ia32') return 'cloudflared-linux-386.deb';
      return 'cloudflared-linux-amd64.deb';
    }
    if (cpu === 'arm64') return 'cloudflared-linux-arm64';
    if (cpu === 'arm') return 'cloudflared-linux-arm';
    if (cpu === 'ia32') return 'cloudflared-linux-386';
    return 'cloudflared-linux-amd64';
  }

  function installSteps(platform, arch) {
    var os = platform || 'linux';
    if (os === 'darwin') {
      return [
        {
          id: 'brew',
          title: 'Homebrew',
          command: 'brew install cloudflared',
        },
        {
          id: 'check',
          title: 'Verifica',
          command: 'cloudflared --version',
        },
      ];
    }
    if (os === 'win32') {
      var exe = assetName('win32', arch);
      return [
        {
          id: 'exe',
          title: 'Eseguibile',
          command: 'https://github.com/cloudflare/cloudflared/releases/latest/download/' + exe,
        },
        {
          id: 'check',
          title: 'Verifica',
          command: 'cloudflared --version',
        },
      ];
    }
    var binary = assetName('linux', arch, 'bin');
    return [
      {
        id: 'binary',
        title: 'Binario',
        command: 'curl -fsSL -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/' + binary + '\nchmod +x cloudflared\nsudo mv cloudflared /usr/local/bin/cloudflared',
      },
      {
        id: 'apt',
        title: 'Debian / Ubuntu',
        command: 'sudo mkdir -p --mode=0755 /usr/share/keyrings\ncurl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null\necho \'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main\' | sudo tee /etc/apt/sources.list.d/cloudflared.list\nsudo apt-get update && sudo apt-get install -y cloudflared',
      },
      {
        id: 'check',
        title: 'Verifica',
        command: 'cloudflared --version',
      },
    ];
  }

  function viewForProbe(probe) {
    var info = probe || {};
    if (!info.present) {
      return {
        phase: 'install',
        actions: INSTALL_ACTIONS.slice(),
        install: {
          missing: 'cloudflared',
          summary: 'I log dei quick tunnel arrivano da cloudflared. Senza il binario nel PATH qui resta solo l’installazione.',
          steps: installSteps(info.platform, info.arch),
        },
        workspace: null,
      };
    }
    return {
      phase: 'workspace',
      actions: WORKSPACE_ACTIONS.slice(),
      install: null,
      workspace: {
        version: info.version || '',
      },
    };
  }

  api.INSTALL_ACTIONS = INSTALL_ACTIONS;
  api.WORKSPACE_ACTIONS = WORKSPACE_ACTIONS;
  api.viewForProbe = viewForProbe;
})(globalThis);
