const openModals = [];
const modalZIndex = 50;

const focusableSelector = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusables(element) {
  if (!element || typeof element.querySelectorAll !== 'function') return [];
  return [...element.querySelectorAll(focusableSelector)].filter(node => !node.hidden && node.offsetParent !== null);
}

function modalEntry(element) {
  return openModals.find(entry => entry.element === element);
}

function syncModalStack() {
  const top = openModals.length - 1;
  openModals.forEach((entry, index) => {
    const active = index === top;
    entry.element.style.zIndex = String(modalZIndex + index);
    entry.element.inert = !active;
    if (typeof entry.element.setAttribute === 'function') entry.element.setAttribute('aria-hidden', String(!active));
  });
  if (document.body && document.body.classList) document.body.classList.toggle('modal-open', openModals.length > 0);
  const wrap = document.querySelector('.wrap');
  if (wrap) wrap.inert = openModals.length > 0;
}

export function focusModal(element, selector = '') {
  if (!element || (typeof element.getAttribute === 'function' && element.getAttribute('aria-hidden') === 'true')) return;
  const selected = selector && typeof element.querySelector === 'function' ? element.querySelector(selector) : null;
  const target = selected || focusables(element)[0] || element;
  if (target === element && typeof element.hasAttribute === 'function' && !element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');
  if (typeof target.focus === 'function') target.focus();
}

export function openModal(element, { onClose, labelledBy = '', focusSelector = '' } = {}) {
  if (!element) return;
  let entry = modalEntry(element);
  if (!entry) {
    entry = { element, previousFocus: document.activeElement, onClose, focusSelector };
    openModals.push(entry);
  } else {
    entry.onClose = onClose || entry.onClose;
    entry.focusSelector = focusSelector || entry.focusSelector;
    const index = openModals.indexOf(entry);
    if (index !== openModals.length - 1) {
      entry.previousFocus = document.activeElement;
      openModals.splice(index, 1);
      openModals.push(entry);
    }
  }
  element.style.display = 'flex';
  if (typeof element.setAttribute === 'function') {
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-modal', 'true');
    if (labelledBy) element.setAttribute('aria-labelledby', labelledBy);
  }
  syncModalStack();
  focusModal(element, entry.focusSelector);
}

export function closeModal(element) {
  if (!element) return;
  const index = openModals.findIndex(entry => entry.element === element);
  const entry = index >= 0 ? openModals.splice(index, 1)[0] : null;
  element.style.display = 'none';
  element.style.zIndex = '';
  element.inert = false;
  if (typeof element.setAttribute === 'function') element.setAttribute('aria-hidden', 'true');
  syncModalStack();
  if (index >= 0 && index === openModals.length) {
    const previous = entry && entry.previousFocus;
    if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus();
    else if (openModals.length) {
      const top = openModals[openModals.length - 1];
      focusModal(top.element, top.focusSelector);
    }
  }
}

export function hasOpenModal() {
  return openModals.length > 0;
}

if (typeof document !== 'undefined') {
  document.addEventListener('keydown', event => {
    const entry = openModals[openModals.length - 1];
    if (!entry) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (entry.onClose) entry.onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables(entry.element);
    if (!items.length) { event.preventDefault(); focusModal(entry.element); return; }
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}
