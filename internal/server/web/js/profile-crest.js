import './theme-registry.js';

const PROFILE_CREST_KEY = 'profile-crest:';

export function loadProfileCrestChoice(id) {
  try { return localStorage.getItem(PROFILE_CREST_KEY + id) || ''; } catch { return ''; }
}

export function saveProfileCrestChoice(id, choice) {
  try { localStorage.setItem(PROFILE_CREST_KEY + id, choice); } catch { }
}

function baseTeamName(name) {
  return String(name || '').trim().replace(/[（(][^（()）]*[）)]\s*$/, '').trim().toLocaleLowerCase();
}

export function profileCrestCandidates(model) {
  if (!model) return [];
  const scopedNames = model.sect
    ? [model.sect]
    : ((model.sect_cands || []).length ? model.sect_cands : (model.teams || []));
  const wanted = new Set(scopedNames.map(baseTeamName).filter(Boolean));
  const themes = globalThis.HUASHAN_THEME_REGISTRY?.themes || [];
  return themes.filter(theme => theme.template === 'team'
    && (theme.matchNames || [theme.name]).some(name => wanted.has(baseTeamName(name))));
}

export function resolveProfileCrest(candidates, choice = '') {
  if (choice === 'none') return null;
  const selected = (candidates || []).find(theme => theme.id === choice);
  if (selected) return selected;
  return (candidates || []).length === 1 ? candidates[0] : null;
}
