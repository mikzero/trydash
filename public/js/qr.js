(function (root) {
  'use strict';

  // QR codes for the tunnel URL, written here because trydash has no dependencies.
  // Byte mode, error correction M (15%), versions 1 to 10: up to 213 bytes, far
  // more than any trycloudflare.com URL. Follows ISO/IEC 18004; checked against
  // a reference encoder and a decoder in the tests.
  var api = root.TryDash || (root.TryDash = {});

  // Per version (index 1..10): EC codewords per block, and [blocks, data codewords] groups.
  var BLOCKS_M = [
    null,
    { ec: 10, groups: [[1, 16]] },
    { ec: 16, groups: [[1, 28]] },
    { ec: 26, groups: [[1, 44]] },
    { ec: 18, groups: [[2, 32]] },
    { ec: 24, groups: [[2, 43]] },
    { ec: 16, groups: [[4, 27]] },
    { ec: 18, groups: [[4, 31]] },
    { ec: 22, groups: [[2, 38], [2, 39]] },
    { ec: 22, groups: [[3, 36], [2, 37]] },
    { ec: 26, groups: [[4, 43], [1, 44]] },
  ];
  var ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  var MAX_VERSION = 10;
  var FORMAT_BITS_M = 0;

  function dataCapacity(version) {
    return BLOCKS_M[version].groups.reduce(function (sum, g) { return sum + g[0] * g[1]; }, 0);
  }

  // ---- Reed-Solomon over GF(256), polynomial 0x11d
  var EXP = new Array(512);
  var LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i += 1) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j += 1) EXP[j] = EXP[j - 255];
  })();

  function mul(a, b) {
    return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
  }

  function generator(degree) {
    var poly = [1];
    for (var i = 0; i < degree; i += 1) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j += 1) {
        next[j] ^= poly[j];
        next[j + 1] ^= mul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function ecCodewords(data, degree) {
    var gen = generator(degree);
    var rest = data.slice().concat(new Array(degree).fill(0));
    for (var i = 0; i < data.length; i += 1) {
      var factor = rest[i];
      if (factor === 0) continue;
      for (var j = 0; j < gen.length; j += 1) rest[i + j] ^= mul(gen[j], factor);
    }
    return rest.slice(data.length);
  }

  function utf8(text) {
    var bytes = [];
    var encoded = unescape(encodeURIComponent(String(text)));
    for (var i = 0; i < encoded.length; i += 1) bytes.push(encoded.charCodeAt(i));
    return bytes;
  }

  // Mode indicator, length, data, terminator, padding: the data codewords.
  function dataCodewords(bytes, version) {
    var bits = [];
    var push = function (value, length) {
      for (var i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
    };
    push(4, 4);
    push(bytes.length, version < 10 ? 8 : 16);
    bytes.forEach(function (b) { push(b, 8); });
    var capacity = dataCapacity(version) * 8;
    push(0, Math.min(4, capacity - bits.length));
    while (bits.length % 8) bits.push(0);
    var words = [];
    for (var i = 0; i < bits.length; i += 8) {
      var w = 0;
      for (var j = 0; j < 8; j += 1) w = (w << 1) | bits[i + j];
      words.push(w);
    }
    for (var pad = 0; words.length < capacity / 8; pad += 1) words.push(pad % 2 ? 0x11 : 0xec);
    return words;
  }

  // Splits into blocks, adds EC to each, then interleaves.
  function finalCodewords(data, version) {
    var spec = BLOCKS_M[version];
    var blocks = [];
    var at = 0;
    spec.groups.forEach(function (g) {
      for (var b = 0; b < g[0]; b += 1) {
        var part = data.slice(at, at + g[1]);
        at += g[1];
        blocks.push({ data: part, ec: ecCodewords(part, spec.ec) });
      }
    });
    var out = [];
    var longest = Math.max.apply(null, blocks.map(function (b) { return b.data.length; }));
    for (var i = 0; i < longest; i += 1) blocks.forEach(function (b) { if (i < b.data.length) out.push(b.data[i]); });
    for (var e = 0; e < spec.ec; e += 1) blocks.forEach(function (b) { out.push(b.ec[e]); });
    return out;
  }

  // ---- The matrix: modules[row][col] is true for dark; reserved marks function patterns.
  function emptyMatrix(size) {
    var rows = [];
    for (var i = 0; i < size; i += 1) rows.push(new Array(size).fill(false));
    return rows;
  }

  function drawFunctionPatterns(m, reserved, version) {
    var size = m.length;
    var set = function (r, c, dark) {
      m[r][c] = dark;
      reserved[r][c] = true;
    };
    // Finders with their separators.
    [[0, 0], [0, size - 7], [size - 7, 0]].forEach(function (corner) {
      for (var dr = -1; dr <= 7; dr += 1) {
        for (var dc = -1; dc <= 7; dc += 1) {
          var r = corner[0] + dr;
          var c = corner[1] + dc;
          if (r < 0 || c < 0 || r >= size || c >= size) continue;
          var ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
          set(r, c, ring !== 2 && ring !== 4);
        }
      }
    });
    // Timing patterns.
    for (var i = 8; i < size - 8; i += 1) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }
    // Alignment patterns, except where they would cover a finder.
    var pos = ALIGN[version];
    pos.forEach(function (r) {
      pos.forEach(function (c) {
        if ((r === 6 && c === 6) || (r === 6 && c === pos[pos.length - 1]) || (r === pos[pos.length - 1] && c === 6)) return;
        for (var dr = -2; dr <= 2; dr += 1) {
          for (var dc = -2; dc <= 2; dc += 1) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      });
    });
    // Format areas (filled later) and the dark module.
    for (var f = 0; f < 9; f += 1) {
      reserved[8][f] = true;
      reserved[f][8] = true;
    }
    for (var g = 0; g < 8; g += 1) {
      reserved[8][size - 1 - g] = true;
      reserved[size - 1 - g][8] = true;
    }
    set(size - 8, 8, true);
    // Version information, from version 7.
    if (version >= 7) {
      var rem = version;
      for (var k = 0; k < 12; k += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      var bits = (version << 12) | rem;
      for (var b = 0; b < 18; b += 1) {
        var dark = ((bits >>> b) & 1) === 1;
        var a = size - 11 + (b % 3);
        var d = Math.floor(b / 3);
        set(d, a, dark);
        set(a, d, dark);
      }
    }
  }

  function placeData(m, reserved, codewords) {
    var size = m.length;
    var bit = 0;
    var total = codewords.length * 8;
    var upward = true;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var step = 0; step < size; step += 1) {
        var r = upward ? size - 1 - step : step;
        for (var k = 0; k < 2; k += 1) {
          var c = right - k;
          if (reserved[r][c]) continue;
          var dark = bit < total ? ((codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1) === 1 : false;
          m[r][c] = dark;
          bit += 1;
        }
      }
      upward = !upward;
    }
  }

  var MASKS = [
    function (r, c) { return (r + c) % 2 === 0; },
    function (r) { return r % 2 === 0; },
    function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return ((r * c) % 2) + ((r * c) % 3) === 0; },
    function (r, c) { return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; },
    function (r, c) { return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; },
  ];

  function applyMask(m, reserved, mask) {
    var out = m.map(function (row) { return row.slice(); });
    for (var r = 0; r < m.length; r += 1) {
      for (var c = 0; c < m.length; c += 1) {
        if (!reserved[r][c] && MASKS[mask](r, c)) out[r][c] = !out[r][c];
      }
    }
    return out;
  }

  function drawFormat(m, mask) {
    var size = m.length;
    var data = (FORMAT_BITS_M << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;
    var bitAt = function (n) { return ((bits >>> n) & 1) === 1; };
    // m[row][col]; the first copy wraps the top-left finder, the second is split.
    for (var a = 0; a <= 5; a += 1) m[a][8] = bitAt(a);
    m[7][8] = bitAt(6);
    m[8][8] = bitAt(7);
    m[8][7] = bitAt(8);
    for (var b = 9; b < 15; b += 1) m[8][14 - b] = bitAt(b);
    for (var c = 0; c < 8; c += 1) m[8][size - 1 - c] = bitAt(c);
    for (var d = 8; d < 15; d += 1) m[size - 15 + d][8] = bitAt(d);
    m[size - 8][8] = true;
  }

  // ISO penalty rules N1..N4; the mask with the lowest score is used.
  function penalty(m) {
    var size = m.length;
    var score = 0;
    var line = function (get) {
      var s = 0;
      for (var i = 0; i < size; i += 1) {
        var run = 1;
        for (var j = 1; j <= size; j += 1) {
          if (j < size && get(i, j) === get(i, j - 1)) run += 1;
          else {
            if (run >= 5) s += 3 + (run - 5);
            run = 1;
          }
        }
        // 1:1:3:1:1 with four light modules on one side; outside the symbol counts as light.
        for (var k = -4; k < size; k += 1) {
          var at = function (n) { var p = k + n; return p >= 0 && p < size ? get(i, p) : false; };
          var core = at(0) && !at(1) && at(2) && at(3) && at(4) && !at(5) && at(6);
          if (!core) continue;
          var before = !at(-1) && !at(-2) && !at(-3) && !at(-4);
          var after = !at(7) && !at(8) && !at(9) && !at(10);
          if (before) s += 40;
          if (after) s += 40;
        }
      }
      return s;
    };
    score += line(function (r, c) { return m[r][c]; });
    score += line(function (c, r) { return m[r][c]; });
    for (var r = 0; r < size - 1; r += 1) {
      for (var c = 0; c < size - 1; c += 1) {
        var v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }
    var dark = 0;
    m.forEach(function (row) { row.forEach(function (x) { if (x) dark += 1; }); });
    var total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }

  // { size, modules, version, mask } for `text`; `mask` forces one (for tests).
  function encode(text, options) {
    var opts = options || {};
    var bytes = utf8(text);
    var version = 1;
    var need = function (v) { return Math.ceil((4 + (v < 10 ? 8 : 16) + bytes.length * 8) / 8); };
    while (version <= MAX_VERSION && need(version) > dataCapacity(version)) version += 1;
    if (version > MAX_VERSION) throw new Error('qr: text too long');
    var size = version * 4 + 17;
    var base = emptyMatrix(size);
    var reserved = emptyMatrix(size);
    drawFunctionPatterns(base, reserved, version);
    placeData(base, reserved, finalCodewords(dataCodewords(bytes, version), version));
    var best = null;
    var masks = opts.mask == null ? [0, 1, 2, 3, 4, 5, 6, 7] : [opts.mask];
    masks.forEach(function (mask) {
      var candidate = applyMask(base, reserved, mask);
      drawFormat(candidate, mask);
      var score = masks.length > 1 ? penalty(candidate) : 0;
      if (!best || score < best.score) best = { score: score, modules: candidate, mask: mask };
    });
    return { size: size, version: version, mask: best.mask, modules: best.modules };
  }

  // One SVG path for the dark modules, with the 4-module quiet zone around.
  function svgPath(qr) {
    var d = [];
    for (var r = 0; r < qr.size; r += 1) {
      for (var c = 0; c < qr.size; c += 1) if (qr.modules[r][c]) d.push('M' + (c + 4) + ' ' + (r + 4) + 'h1v1h-1z');
    }
    return d.join('');
  }

  function buildQrSvg(text) {
    var qr = encode(text);
    var ns = 'http://www.w3.org/2000/svg';
    var view = qr.size + 8;
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + view + ' ' + view);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', text);
    var bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('width', String(view));
    bg.setAttribute('height', String(view));
    bg.setAttribute('class', 'qr-bg');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', svgPath(qr));
    path.setAttribute('class', 'qr-fg');
    svg.append(bg, path);
    return svg;
  }

  api.qr = { encode: encode, svgPath: svgPath, MAX_VERSION: MAX_VERSION, dataCapacity: dataCapacity };
  api.buildQrSvg = buildQrSvg;
})(globalThis);
