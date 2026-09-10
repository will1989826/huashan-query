(function initThemeRegistry(scope) {
  if (scope.HUASHAN_THEME_REGISTRY) return;

  const requiredColors = [
    'background', 'surface', 'surfaceAlt', 'border', 'text', 'muted',
    'primary', 'primarySoft', 'secondary', 'accent', 'accentText', 'link',
    'danger', 'hover', 'onPrimary', 'buttonTop', 'buttonBottom',
  ];
  // 品牌主题额外需要天光与地色，用来铺渐变底和远山剪影。
  const requiredBrandColors = [...requiredColors, 'sky', 'ground'];
  const paletteVars = Object.freeze({
    background: '--bg', surface: '--card', surfaceAlt: '--card2', border: '--line',
    text: '--fg', muted: '--sub', primary: '--acc', primarySoft: '--acc-d',
    accentText: '--gold', link: '--blue', danger: '--danger', hover: '--hover',
    onPrimary: '--on-acc', buttonTop: '--button-top', buttonBottom: '--button-bottom',
    secondary: '--theme-secondary', accent: '--theme-accent',
  });
  const brandVars = Object.freeze({ sky: '--brand-sky', ground: '--brand-ground' });
  const managedVars = Object.freeze([
    ...Object.values(paletteVars), ...Object.values(brandVars), '--team-crest', '--brand-wordmark', '--brand-landscape',
  ]);

  function createPaletteTheme(config, { template, kind, artKeys, required }) {
    const missingIdentity = ['id', 'name', 'desc', ...artKeys].filter(key => !config[key]);
    const missingColors = required.filter(key => !config.palette || !config.palette[key]);
    const validID = /^[a-z0-9-]+$/.test(config.id || '');
    if (!validID || missingIdentity.length || missingColors.length) {
      const missing = [...missingIdentity, ...missingColors];
      throw new Error(`Invalid ${template} theme ${config.id || '<unknown>'}: ${missing.length ? `missing ${missing.join(', ')}` : 'invalid id'}`);
    }
    const matchNames = [...new Set((config.matchNames || [config.name]).map(name => String(name || '').trim()).filter(Boolean))];
    return Object.freeze({
      ...config,
      template,
      kind: config.kind || kind,
      matchNames: Object.freeze(matchNames),
      palette: Object.freeze({ ...config.palette }),
    });
  }

  function createTeamTheme(config) {
    return createPaletteTheme(config, { template: 'team', kind: '战队', artKeys: ['crest'], required: requiredColors });
  }

  function createBrandTheme(config) {
    return createPaletteTheme(config, { template: 'brand', kind: '赛事', artKeys: ['wordmark', 'landscape'], required: requiredBrandColors });
  }

  // 新战队主题只需在这里增加一项，并提交对应的透明队徽资源。
  const themes = Object.freeze([
    createBrandTheme({
      id: 'huashan-day',
      name: '华山论剑·昼',
      englishName: 'HUASHAN DAY',
      desc: '晴空天青与宣纸暖白，金色字标压顶。',
      wordmark: 'assets/huashan-wordmark.svg',
      landscape: 'assets/huashan-day-landscape.webp',
      palette: {
        background: '#eef1ee', surface: '#fbfaf5', surfaceAlt: '#e8eeeb', border: '#c9d4d0',
        text: '#27383d', muted: '#687b80', primary: '#3f7885', primarySoft: '#d8e9e9',
        secondary: '#729ba3', accent: '#b08b43', accentText: '#80621f', link: '#326f80',
        danger: '#aa4238', hover: '#e1e9e5', onPrimary: '#ffffff',
        buttonTop: '#568f9b', buttonBottom: '#356d79',
        sky: '#edf4f3', ground: '#f2f0e8',
      },
    }),
    createBrandTheme({
      id: 'huashan-night',
      name: '华山论剑·夜',
      englishName: 'HUASHAN NIGHT',
      desc: '水墨夜色与远山剪影，金色字标压顶。',
      wordmark: 'assets/huashan-wordmark.svg',
      landscape: 'assets/huashan-night-landscape.webp',
      palette: {
        background: '#081321', surface: '#101e2d', surfaceAlt: '#17283a', border: '#2b4054',
        text: '#e6edf1', muted: '#93a4b3', primary: '#74b8c6', primarySoft: '#153b45',
        secondary: '#527f96', accent: '#d2ad65', accentText: '#e2c47e', link: '#8dc9de',
        danger: '#f17676', hover: '#1c3043', onPrimary: '#071f27',
        buttonTop: '#83c8d5', buttonBottom: '#4d93a3',
        sky: '#101e32', ground: '#07111e',
      },
    }),
    createTeamTheme({
      id: 'yulehui',
      name: '鱼乐会',
      englishName: 'YULEHUI CLUB',
      desc: '队服白、海军蓝与皇家蓝，金色点睛。',
      crest: 'assets/yulehui-crest.webp',
      palette: {
        background: '#f2f6fc', surface: '#ffffff', surfaceAlt: '#edf3fc', border: '#c9d5ec',
        text: '#0c154f', muted: '#58698f', primary: '#0866e8', primarySoft: '#d4e4ff',
        secondary: '#00caeb', accent: '#f0b900', accentText: '#987000', link: '#007fa8',
        danger: '#b83247', hover: '#e2eaf8', onPrimary: '#ffffff',
        buttonTop: '#1678ff', buttonBottom: '#0757ce',
      },
    }),
    createTeamTheme({
      id: 'jinfeng-xiyulou',
      name: '金风细雨楼',
      englishName: 'JINFENG XIYULOU',
      desc: '队服白与藏青渐变，天青和金色点缀。',
      crest: 'assets/jinfeng-xiyulou-crest.webp',
      palette: {
        background: '#f2f5f8', surface: '#ffffff', surfaceAlt: '#e9eef3', border: '#c5d0dc',
        text: '#18304d', muted: '#586c81', primary: '#1e466f', primarySoft: '#d9e5f0',
        secondary: '#65abc1', accent: '#d3a322', accentText: '#775700', link: '#126d8b',
        danger: '#aa3a34', hover: '#dfe7ee', onPrimary: '#ffffff',
        buttonTop: '#2a5a87', buttonBottom: '#173b61',
      },
    }),
  ]);

  const defaultTheme = 'huashan-day';
  const themeByID = new Map(themes.map(theme => [theme.id, theme]));

  function findTheme(id) {
    return themeByID.get(String(id || '')) || null;
  }

  function currentTheme() {
    const root = scope.document && scope.document.documentElement;
    const selected = root && typeof root.getAttribute === 'function' ? root.getAttribute('data-theme') : '';
    return findTheme(selected) ? selected : defaultTheme;
  }

  function clearManagedVars(root) {
    if (!root.style || typeof root.style.removeProperty !== 'function') return;
    managedVars.forEach(name => root.style.removeProperty(name));
  }

  function cssURL(path) {
    return `url("${String(path).replace(/["\\]/g, '\\$&')}")`;
  }

  function applyPaletteVars(root, theme) {
    if (!root.style || typeof root.style.setProperty !== 'function') return;
    Object.entries(paletteVars).forEach(([key, name]) => root.style.setProperty(name, theme.palette[key]));
    if (theme.template === 'team') {
      root.style.setProperty('--team-crest', cssURL(theme.crest));
      return;
    }
    Object.entries(brandVars).forEach(([key, name]) => root.style.setProperty(name, theme.palette[key]));
    root.style.setProperty('--brand-wordmark', cssURL(theme.wordmark));
    root.style.setProperty('--brand-landscape', cssURL(theme.landscape));
  }

  function syncBrand(id = currentTheme()) {
    const doc = scope.document;
    if (!doc || typeof doc.querySelector !== 'function') return;
    const theme = findTheme(id);
    const team = theme && theme.template === 'team' ? theme : null;
    const brand = theme && theme.template === 'brand' ? theme : null;
    const currentName = doc.querySelector('#theme-current-name');
    const image = doc.querySelector('#home-team-crest');
    const name = doc.querySelector('#home-team-name');
    const englishName = doc.querySelector('#home-team-english-name');
    const wordmark = doc.querySelector('#home-brand-wordmark');
    if (currentName) currentName.textContent = theme ? theme.name : themes[0].name;
    if (image) {
      if (team) image.setAttribute('src', team.crest);
      else image.removeAttribute('src');
    }
    if (name) name.textContent = team ? team.name : '';
    if (englishName) englishName.textContent = team ? (team.englishName || team.name) : '';
    if (wordmark) {
      if (brand) wordmark.setAttribute('src', brand.wordmark);
      else wordmark.removeAttribute('src');
    }
  }

  function applyTheme(id, { persist = false } = {}) {
    const theme = findTheme(id);
    const root = scope.document && scope.document.documentElement;
    if (!theme || !root) return false;

    clearManagedVars(root);
    root.setAttribute('data-theme', theme.id);
    if (theme.template === 'team' || theme.template === 'brand') {
      root.setAttribute('data-theme-template', theme.template);
      applyPaletteVars(root, theme);
    } else {
      root.removeAttribute('data-theme-template');
    }
    syncBrand(theme.id);
    if (persist) {
      try { scope.localStorage.setItem('theme', theme.id); } catch (e) { }
    }
    return true;
  }

  function restoreTheme() {
    let stored = '';
    try { stored = scope.localStorage.getItem('theme') || ''; } catch (e) { }
    applyTheme(findTheme(stored) ? stored : defaultTheme);
  }

  scope.HUASHAN_THEME_REGISTRY = Object.freeze({ themes, defaultTheme, findTheme, currentTheme, applyTheme, restoreTheme, syncBrand });
  if (scope.document) {
    restoreTheme();
    if (scope.document.readyState === 'loading' && typeof scope.document.addEventListener === 'function') {
      scope.document.addEventListener('DOMContentLoaded', () => syncBrand(), { once: true });
    }
  }
})(globalThis);
