/* BOXBASE · MedScan — read medicine name + expiry from a photo, fully on the phone.
   1) QR / DataMatrix / barcode on the pack (India Schedule H2 QR, GS1 codes)
   2) OCR of the printed label (Tesseract) → finds "EXP 12/2027"-style dates + biggest text as name
   Libraries load lazily from jsDelivr the first time a medicine is scanned. */
const MedScan = (() => {
  const CFG = Object.assign({
    jsqr: 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
    zxing: 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js',
    tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
    tesseractOpts: {},
  }, window.MEDSCAN_CFG || {});

  const loaded = {};
  const load = src => loaded[src] ||= new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res;
    s.onerror = () => { delete loaded[src]; rej(new Error('Could not load ' + src)); };
    document.head.append(s);
  });

  /* ---------------- dates ---------------- */
  const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12 };
  const p2 = n => String(n).padStart(2, '0');
  function norm(y, m, d) {
    y = +y; if (y < 100) y += 2000; m = +m; d = d == null ? null : +d;
    if (!(m >= 1 && m <= 12) || y < 2010 || y > 2050) return null;
    if (d != null && !(d >= 1 && d <= 31)) return null;
    return `${y}-${p2(m)}` + (d ? `-${p2(d)}` : '');
  }
  const endOf = v => { const [y, m, d] = v.split('-').map(Number); return d ? new Date(y, m - 1, d) : new Date(y, m, 0); };

  // OCR clean-up: O→0, I/l→1, S→5 only when glued to digits
  const fixDigits = s => s.replace(/(?<=\d)[Oo]|[Oo](?=\d)/g, '0').replace(/(?<=\d)[Il|]|[Il|](?=\d{1,3}\b)/g, '1').replace(/(?<=\d)S(?=\d)/g, '5');

  const DATE_RES = [
    // 12/03/2027, 12-03-27, 12.03.2027
    [/\b(\d{1,2})\s?[\/\-.]\s?(\d{1,2})\s?[\/\-.]\s?(20\d{2}|\d{2})\b/g, m => norm(m[3], m[2], m[1])],
    // 2027-03(-12)
    [/\b(20\d{2})[\/\-.](\d{1,2})(?:[\/\-.](\d{1,2}))?\b/g, m => norm(m[1], m[2], m[3])],
    // 12 MAR 2027, MAR.2027, MAR-27, MAR 27, MARCH 2027
    [/\b(?:(\d{1,2})\s?[\-.\/ ]?\s?)?(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEPT?|OCT|NOV|DEC)[A-Z]*\.?\s?[\-.\/,' ]?\s?(20\d{2}|\d{2})\b/g, m => norm(m[3], MON[m[2]], m[1])],
    // 03/2027, 03-27, 03.27
    [/\b(\d{1,2})\s?[\/\-.]\s?(20\d{2}|\d{2})\b/g, m => norm(m[2], m[1])],
  ];
  const EXP_KW = /\b(EXP(?:IRY|IRES|\.?\s?DATE|\.?\s?DT)?|E\.?\s?D\.?|USE\s*(?:BEFORE|BY)|BEST\s*BEFORE|BB)\b|\bEXP|\bE\s*[:.]/g;
  const MFG_KW = /\b(MFG|MFD|MANUF\w*|MF\.?\s?DATE|M\.?\s?D\.?|DOM|PKD)\b|\bM\s*[:.]/g;

  function findDates(text) {
    const s = fixDigits(text.toUpperCase());
    const taken = [], out = [];
    for (const [re, fn] of DATE_RES) {
      for (const m of s.matchAll(re)) {
        const a = m.index, b = a + m[0].length;
        if (taken.some(([x, y]) => a < y && b > x)) continue;
        const v = fn(m); if (!v) continue;
        taken.push([a, b]); out.push({ i: a, v });
      }
    }
    const kw = (re, tag) => [...s.matchAll(re)].map(m => ({ i: m.index, tag }));
    const kws = [...kw(EXP_KW, 'exp'), ...kw(MFG_KW, 'mfg')].sort((a, b) => a.i - b.i);
    // each keyword labels only the first date that follows it (within 40 chars)
    out.sort((a, b) => a.i - b.i);
    for (const k of kws) {
      const d = out.find(d => d.i > k.i && d.i - k.i <= 40 && !d.tag);
      if (d && !out.some(o => o.i > k.i && o.i < d.i)) d.tag = k.tag;
    }
    return out;
  }
  function pickExpiry(text) {
    const ds = findDates(text);
    const tagged = ds.filter(d => d.tag === 'exp');
    if (tagged.length) return { exp: tagged[0].v, sure: true };
    const rest = ds.filter(d => d.tag !== 'mfg');
    if (!rest.length) return { exp: null, sure: false };
    rest.sort((a, b) => endOf(b.v) - endOf(a.v));          // latest date is usually the expiry
    return { exp: rest[0].v, sure: ds.length >= 2 };
  }

  /* ---------------- codes ---------------- */
  function parseGS1(raw) {
    let s = raw.replace(/^\][A-Za-z]\d/, '');
    const o = {};
    if (/\(\d{2,4}\)/.test(s)) { s.replace(/\((\d{2,4})\)([^(]*)/g, (_, ai, v) => { o[ai] = v.trim(); }); return Object.keys(o).length ? o : null; }
    if (!/^(01|02|10|11|17|21)\d/.test(s)) return null;
    const FIX = { '00': 18, '01': 14, '02': 14, '11': 6, '13': 6, '15': 6, '17': 6 }, GS = '\x1d';
    let i = 0;
    while (i < s.length) {
      if (s[i] === GS) { i++; continue; }
      const ai = s.substr(i, 2); if (!/^\d\d$/.test(ai)) break; i += 2;
      if (FIX[ai]) { o[ai] = s.substr(i, FIX[ai]); i += FIX[ai]; }
      else { let j = s.indexOf(GS, i); if (j < 0) j = s.length; o[ai] = s.slice(i, j); i = j; }
    }
    return Object.keys(o).length ? o : null;
  }
  const gs1Date = v => v && /^\d{6}$/.test(v) ? norm(v.slice(0, 2), v.slice(2, 4), v.slice(4) === '00' ? null : v.slice(4)) : null;

  function parseCodeText(raw) {
    const r = { name: null, exp: null, url: null, batch: null };
    const t = raw.trim();
    if (/^https?:\/\//i.test(t)) { r.url = t; return r; }
    const g = parseGS1(t);
    if (g) { r.exp = gs1Date(g['17']); r.batch = g['10'] || null; if (g['21'] && !r.exp) r.batch ||= g['21']; return r; }
    let obj = null; try { obj = JSON.parse(t); } catch {}
    if (obj && typeof obj === 'object') {
      const flat = Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join('\n');
      return { ...r, ...parseKV(flat) };
    }
    return { ...r, ...parseKV(t) };
  }
  function parseKV(t) {
    const get = re => (t.match(re) || [])[1]?.trim().replace(/[|;]+$/, '') || null;
    const name = get(/brand\s*(?:name)?\s*[:=\-]\s*([^\n|;]+)/i) || get(/product\s*(?:name)?\s*[:=\-]\s*([^\n|;]+)/i)
      || get(/(?:proper|generic)\s*(?:and\s*generic\s*)?name\s*[:=\-]\s*([^\n|;]+)/i) || get(/\bname\s*[:=\-]\s*([^\n|;]+)/i);
    const expLine = get(/exp\w*\s*(?:date|dt)?\s*[:=\-]?\s*([^\n|;]+)/i);
    const exp = (expLine && pickExpiry('EXP ' + expLine).exp) || pickExpiry(t).exp;
    return { name, exp, batch: get(/batch\s*(?:no\.?|number)?\s*[:=\-]\s*([^\n|;]+)/i) };
  }

  async function decodeCodes(file) {
    const found = [];
    if ('BarcodeDetector' in window) {
      try {
        const want = ['qr_code', 'data_matrix', 'code_128', 'ean_13', 'upc_a'];
        const fm = (await BarcodeDetector.getSupportedFormats()).filter(f => want.includes(f));
        if (fm.length) {
          const det = new BarcodeDetector({ formats: fm });
          const bmp = await createImageBitmap(file);
          (await det.detect(bmp)).forEach(r => r.rawValue && found.push(r.rawValue));
        }
      } catch {}
    }
    if (!found.length) {                       // QR codes: jsQR is the most reliable in-browser reader
      try {
        await load(CFG.jsqr);
        for (const max of [1600, 900, 2400]) {
          const c = await canvasOf(file, max);
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
          const r = window.jsQR(d.data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
          if (r?.data) { found.push(r.data); break; }
        }
      } catch {}
    }
    if (!found.length) {                       // DataMatrix (GS1) + 1D barcodes
      try {
        await load(CFG.zxing);
        const Z = window.ZXing, hints = new Map();
        hints.set(Z.DecodeHintType.TRY_HARDER, true);
        hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.DATA_MATRIX, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.EAN_13]);
        const reader = new Z.BrowserMultiFormatReader(hints);
        for (const max of [1400, 2400]) {
          try { const res = await reader.decodeFromImageUrl(await scaled(file, max, false)); found.push(res.getText()); break; } catch {}
        }
      } catch {}
    }
    return found;
  }

  /* ---------------- OCR ---------------- */
  let workerP = null, progressCb = null;
  async function worker() {
    if (!workerP) workerP = (async () => {
      await load(CFG.tesseract);
      return Tesseract.createWorker('eng', 1, { ...CFG.tesseractOpts, logger: m => { if (m.status === 'recognizing text') progressCb?.(m.progress); } });
    })().catch(e => { workerP = null; throw e; });
    return workerP;
  }
  async function canvasOf(file, max) {
    const img = await createImageBitmap(file);
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  // downscale + grayscale + contrast stretch (helps faint strip print)
  async function scaled(file, max = 1800, enhance = true, rotate = 0) {
    const img = await createImageBitmap(file);
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.round(img.width * s), h = Math.round(img.height * s);
    const c = document.createElement('canvas');
    const rot = rotate % 180 !== 0;
    c.width = rot ? h : w; c.height = rot ? w : h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.translate(c.width / 2, c.height / 2); x.rotate(rotate * Math.PI / 180); x.drawImage(img, -w / 2, -h / 2, w, h);
    if (enhance) {
      const d = x.getImageData(0, 0, c.width, c.height), px = d.data;
      let lo = 255, hi = 0; const L = new Uint8ClampedArray(px.length / 4);
      for (let i = 0, j = 0; i < px.length; i += 4, j++) { const v = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000; L[j] = v; }
      const sortedSample = Array.from(L.filter((_, i) => i % 50 === 0)).sort((a, b) => a - b);
      lo = sortedSample[Math.floor(sortedSample.length * 0.02)] || 0; hi = sortedSample[Math.floor(sortedSample.length * 0.98)] || 255;
      const k = 255 / Math.max(1, hi - lo);
      for (let i = 0, j = 0; i < px.length; i += 4, j++) { const v = (L[j] - lo) * k; px[i] = px[i + 1] = px[i + 2] = v; }
      x.putImageData(d, 0, 0);
    }
    return c.toDataURL('image/png');
  }
  const STOP = /\b(exp|mfg|mfd|batch|b\.?\s?no|price|m\.?r\.?p|rs\.?|incl|taxes|each|contains|composition|store|schedule|warning|caution|manufactured|marketed|lic|dosage|keep|reach|children|physician|directed|protect|light|only|prescription|retail|sale|tablets?\s+ip$|address|ltd|limited|pvt|india|road|dist)\b/i;
  /* lines carry .rel = line height ÷ image height, so big headline text wins across passes */
  function guessName(lines) {
    let best = null;
    for (const l of lines) {
      const t = l.text.replace(/[^A-Za-z0-9+\-\s.%]/g, ' ').replace(/\s+/g, ' ').trim();
      const letters = (t.match(/[A-Za-z]/g) || []).length;
      if (letters < 3 || t.length > 40 || !/[A-Za-z]{3,}/.test(t) || letters / t.replace(/\s/g, '').length < 0.45) continue;
      if (STOP.test(t) || l.confidence < 60) continue;
      const score = l.rel * (0.7 + 0.3 * letters / t.length) * (l.confidence / 100) * (t.split(' ').length <= 3 ? 1.15 : 1);
      if (!best || score > best.score) best = { t, score };
    }
    if (!best) return null;
    const t = best.t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9%+]+$/g, '');
    return t === t.toUpperCase() ? t.replace(/\b([A-Z])([A-Z]+)\b/g, (_, a, b) => a + b.toLowerCase()) : t;
  }
  async function readText(file, onProgress, rotate = 0, max = 1800, sparse = false) {
    const w = await worker(); progressCb = onProgress;
    const url = await scaled(file, max, true, rotate);
    await w.setParameters({ tessedit_pageseg_mode: sparse ? '11' : '3' });   // 11 = sparse text: catches big brand headlines
    const { data } = await w.recognize(url);
    progressCb = null;
    const H = (data.lines || []).reduce((m, l) => Math.max(m, l.bbox.y1), 1);
    const imgH = await new Promise(r => { const i = new Image(); i.onload = () => r(i.height); i.src = url; });
    data.lines = (data.lines || []).map(l => ({ ...l, rel: (l.bbox.y1 - l.bbox.y0) / (imgH || H) }));
    return data;
  }

  /* ---------------- main ---------------- */
  /* scan(file, {onStatus}) → { name, exp, expSure, batch, url, via } */
  async function scan(file, { onStatus = () => {}, wantName = true } = {}) {
    const res = { name: null, exp: null, expSure: false, batch: null, url: null, via: [] };
    onStatus('Looking for a code…');
    for (const raw of await decodeCodes(file)) {
      const r = parseCodeText(raw);
      if (r.url) res.url ||= r.url;
      if (r.exp && !res.exp) { res.exp = r.exp; res.expSure = true; res.via.push('code'); }
      if (r.name && !res.name) res.name = r.name;
      if (r.batch) res.batch ||= r.batch;
    }
    if (res.exp && (res.name || !wantName)) return res;
    const say = (m, a, b) => p => onStatus(m, a + (b - a) * (p || 0));
    let data, rot = 0;
    try {
      data = await readText(file, say('Reading the label…', 0, 0.55), 0);
      if (data.confidence < 55) {                       // photo probably sideways → try both turns, keep the clearest
        for (const r of [90, 270]) {
          const d = await readText(file, say('Trying it sideways…', 0.55, 0.85), r);
          if (d.confidence > data.confidence) { data = d; rot = r; }
        }
      }
    } catch (e) { onStatus('Couldn’t load the reader — check internet'); return res; }
    if (!res.exp) { const e = pickExpiry(data.text); if (e.exp) { res.exp = e.exp; res.expSure = e.sure; res.via.push('text'); } }
    if (wantName && !res.name && data.confidence >= 50) {
      let lines = data.lines;
      try { const small = await readText(file, say('Looking for the name…', 0.85, 1), rot, 700, true); lines = lines.concat(small.lines); } catch {}
      res.name = guessName(lines);
    }
    return res;
  }

  return { scan, pickExpiry, findDates, parseGS1, parseCodeText, guessName, endOf };
})();
window.MedScan = MedScan;
