(function initThemeRegistry(scope) {
  if (scope.HUASHAN_THEME_REGISTRY) return;

  const requiredTeamColors = [
    'background', 'surface', 'surfaceAlt', 'border', 'text', 'muted',
    'primary', 'primarySoft', 'secondary', 'accent', 'accentText', 'link',
    'danger', 'hover', 'onPrimary', 'buttonTop', 'buttonBottom',
  ];
  const paletteVars = Object.freeze({
    background: '--bg', surface: '--card', surfaceAlt: '--card2', border: '--line',
    text: '--fg', muted: '--sub', primary: '--acc', primarySoft: '--acc-d',
    accentText: '--gold', link: '--blue', danger: '--danger', hover: '--hover',
    onPrimary: '--on-acc', buttonTop: '--button-top', buttonBottom: '--button-bottom',
    secondary: '--team-secondary', accent: '--team-accent',
  });
  const managedVars = Object.freeze([...Object.values(paletteVars), '--team-crest']);

  function createTeamTheme(config) {
    const missingIdentity = ['id', 'name', 'desc', 'crest'].filter(key => !config[key]);
    const missingColors = requiredTeamColors.filter(key => !config.palette || !config.palette[key]);
    const validID = /^[a-z0-9-]+$/.test(config.id || '');
    if (!validID || missingIdentity.length || missingColors.length) {
      const missing = [...missingIdentity, ...missingColors];
      throw new Error(`Invalid team theme ${config.id || '<unknown>'}: ${missing.length ? `missing ${missing.join(', ')}` : 'invalid id'}`);
    }
    const matchNames = [...new Set((config.matchNames || [config.name]).map(name => String(name || '').trim()).filter(Boolean))];
    return Object.freeze({
      ...config,
      template: 'team',
      kind: config.kind || '战队',
      matchNames: Object.freeze(matchNames),
      palette: Object.freeze({ ...config.palette }),
    });
  }

  // 新战队主题只需在这里增加一项，并提交对应的透明队徽资源。
  const themes = Object.freeze([
    Object.freeze({ id: 'dark', name: '青崖夜', kind: '深色', desc: '青黑底色与薄荷高光，适合夜间查看。' }),
    Object.freeze({ id: 'light', name: '朱砂笺', kind: '浅色', desc: '暖纸底色与朱砂强调，清爽柔和。' }),
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

  const themeByID = new Map(themes.map(theme => [theme.id, theme]));

  function findTheme(id) {
    return themeByID.get(String(id || '')) || null;
  }

  function currentTheme() {
    const root = scope.document && scope.document.documentElement;
    const selected = root && typeof root.getAttribute === 'function' ? root.getAttribute('data-theme') : '';
    return findTheme(selected) ? selected : 'dark';
  }

  function clearManagedVars(root) {
    if (!root.style || typeof root.style.removeProperty !== 'function') return;
    managedVars.forEach(name => root.style.removeProperty(name));
  }

  function applyTeamVars(root, theme) {
    if (!root.style || typeof root.style.setProperty !== 'function') return;
    Object.entries(paletteVars).forEach(([key, name]) => root.style.setProperty(name, theme.palette[key]));
    const safeCrest = String(theme.crest).replace(/["\\]/g, '\\$&');
    root.style.setProperty('--team-crest', `url("${safeCrest}")`);
  }

  function syncBrand(id = currentTheme()) {
    const doc = scope.document;
    if (!doc || typeof doc.querySelector !== 'function') return;
    const theme = findTheme(id);
    const team = theme && theme.template === 'team' ? theme : null;
    const currentName = doc.querySelector('#theme-current-name');
    const image = doc.querySelector('#home-team-crest');
    const name = doc.querySelector('#home-team-name');
    const englishName = doc.querySelector('#home-team-english-name');
    if (currentName) currentName.textContent = theme ? theme.name : themes[0].name;
    if (image) {
      if (team) image.setAttribute('src', team.crest);
      else image.removeAttribute('src');
    }
    if (name) name.textContent = team ? team.name : '';
    if (englishName) englishName.textContent = team ? (team.englishName || team.name) : '';
  }

  function applyTheme(id, { persist = false } = {}) {
    const theme = findTheme(id);
    const root = scope.document && scope.document.documentElement;
    if (!theme || !root) return false;

    clearManagedVars(root);
    if (theme.id === 'dark') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme.id);
    if (theme.template === 'team') {
      root.setAttribute('data-theme-template', 'team');
      applyTeamVars(root, theme);
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
    applyTheme(findTheme(stored) ? stored : 'dark');
  }

  scope.HUASHAN_THEME_REGISTRY = Object.freeze({ themes, findTheme, currentTheme, applyTheme, restoreTheme, syncBrand });
  if (scope.document) {
    restoreTheme();
    if (scope.document.readyState === 'loading' && typeof scope.document.addEventListener === 'function') {
      scope.document.addEventListener('DOMContentLoaded', () => syncBrand(), { once: true });
    }
  }
})(globalThis);
