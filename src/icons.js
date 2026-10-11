// Tabler Icons (MIT — see public/icons/LICENSE).
//
// Vendored as path data so the UI needs no font, no CDN, and no extra
// request: the desktop build and offline work stay intact. Outline style,
// 24×24 grid, 2px stroke in currentColor — every icon follows the
// surrounding text color and both themes for free.
const PATHS = {

  'sidebar': '<path d="M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12" /> <path d="M9 4l0 16" />',
  'file-text': '<path d="M14 3v4a1 1 0 0 0 1 1h4" /> <path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2" /> <path d="M9 9l1 0" /> <path d="M9 13l6 0" /> <path d="M9 17l6 0" />',
  'file-plus': '<path d="M14 3v4a1 1 0 0 0 1 1h4" /> <path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2" /> <path d="M12 11l0 6" /> <path d="M9 14l6 0" />',
  'upload-simple': '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2" /> <path d="M7 9l5 -5l5 5" /> <path d="M12 4l0 12" />',
  'download-simple': '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2" /> <path d="M7 11l5 5l5 -5" /> <path d="M12 4l0 12" />',
  'clock-counter-clockwise': '<path d="M12 8l0 4l2 2" /> <path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5" />',
  'magnifying-glass': '<path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" /> <path d="M21 21l-6 -6" />',
  'x': '<path d="M18 6l-12 12" /> <path d="M6 6l12 12" />',
  'arrows-clockwise': '<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" /> <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />',
  'gear': '<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065" /> <path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" />',
  'arrow-up': '<path d="M12 5l0 14" /> <path d="M18 11l-6 -6" /> <path d="M6 11l6 -6" />',
  'plus': '<path d="M12 5l0 14" /> <path d="M5 12l14 0" />',
  'check': '<path d="M5 12l5 5l10 -10" />',
  'alert': '<path d="M12 9v4" /> <path d="M12 17l.01 0" /> <path d="M5 19h14a2 2 0 0 0 1.84 -2.75l-7.1 -12.25a2 2 0 0 0 -3.48 0l-7.1 12.25a2 2 0 0 0 1.84 2.75" />',
  'info': '<path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" /> <path d="M12 8l.01 0" /> <path d="M11 12l1 0l0 4l1 0" />',
  'bulb': '<path d="M9 18h6" /> <path d="M10 21h4" /> <path d="M12 3a6 6 0 0 0 -3.5 11.2c.7 .6 1 1.4 1 2.3l5 0c0 -.9 .3 -1.7 1 -2.3a6 6 0 0 0 -3.5 -11.2" />',
  'target': '<path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" /> <path d="M12 12m-5 0a5 5 0 1 0 10 0a5 5 0 1 0 -10 0" /> <path d="M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />',
};

export function icon(name) {
  const body = PATHS[name];
  if (!body) return '';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

// Static markup names icons with <span class="ph" data-icon="…">; dynamic
// rows use icon() directly. One map serves both, so the set stays identical.
export function hydrateIcons(root = document) {
  for (const slot of root.querySelectorAll('[data-icon]')) {
    const svg = icon(slot.dataset.icon);
    if (svg) slot.innerHTML = svg;
  }
}
