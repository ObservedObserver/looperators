/**
 * Theme registry.
 *
 * A theme is one full token set per mode (light/dark), defined as CSS blocks
 * in `src/index.css` and selected via the `data-theme` attribute on <html>.
 * The mode axis (`.dark` class) is independent and orthogonal.
 */

export type ThemeId = 'lime' | 'inkstone' | 'harbor' | 'ember';

export interface ThemeDefinition {
  id: ThemeId;
  label: string;
  description: string;
  /** Swatch pair for the picker: [surface, accent] per mode. */
  preview: { light: [string, string]; dark: [string, string] };
}

export const themes: ThemeDefinition[] = [
  {
    id: 'lime',
    label: 'Lime',
    description: 'The original high-contrast ink terminal.',
    preview: { light: ['#f8fafc', '#a3e635'], dark: ['#07090a', '#a3e635'] },
  },
  {
    id: 'inkstone',
    label: 'Inkstone',
    description: 'Warm graphite with a moss accent; the low-fatigue evolution of Lime.',
    preview: { light: ['#eef0ec', '#37725f'], dark: ['#171a17', '#a4bf7d'] },
  },
  {
    id: 'harbor',
    label: 'Dusk Harbor',
    description: 'Slate blue with a frost accent; calm professional tooling.',
    preview: { light: ['#eff1f4', '#3e6e96'], dark: ['#191d23', '#8caecf'] },
  },
  {
    id: 'ember',
    label: 'Ember',
    description: 'Warm charcoal with a matte amber accent; a dimmed CRT without the glare.',
    preview: { light: ['#f3f0ea', '#9a6a23'], dark: ['#1b1917', '#d0a468'] },
  },
];

export const defaultThemeId: ThemeId = 'lime';

export const themeStorageKey = 'orrery.theme.v1';

export function isThemeId(value: string): value is ThemeId {
  return themes.some((theme) => theme.id === value);
}

export function initialTheme(): ThemeId {
  if (typeof window === 'undefined') {
    return defaultThemeId;
  }

  try {
    const stored = window.localStorage.getItem(themeStorageKey);
    return stored && isThemeId(stored) ? stored : defaultThemeId;
  } catch {
    return defaultThemeId;
  }
}
