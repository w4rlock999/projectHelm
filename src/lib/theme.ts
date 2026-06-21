/**
 * Home-page background themes. The active theme is applied as a
 * `theme-<id>` class on the `.helm-home` root (see styles.css) and persisted
 * to localStorage so it survives reloads.
 */
import { useCallback, useEffect, useState } from 'react'

export type ThemeId = 'ember' | 'atelier' | 'smoked' | 'linen' | 'tide'

export interface ThemeMeta {
  id: ThemeId
  name: string
  description: string
  /** CSS background used for the little preview swatch in the settings dialog. */
  swatch: string
}

export const THEMES: ThemeMeta[] = [
  {
    id: 'ember',
    name: 'Ember Dusk',
    description: 'Warm terracotta glow sinking into a charred dusk.',
    swatch:
      'radial-gradient(120% 120% at 12% 0%, rgba(232,142,94,0.9), transparent 55%),' +
      'linear-gradient(152deg,#c4683c 0%,#6f3b26 58%,#150d0a 100%)',
  },
  {
    id: 'atelier',
    name: 'Atelier',
    description: 'A warm studio corner washed in soft, raking light.',
    swatch:
      'radial-gradient(80% 130% at -8% 48%, rgba(248,241,227,0.95), transparent 46%),' +
      'linear-gradient(0deg, rgba(206,190,166,0.6) 0%, transparent 20%),' +
      'linear-gradient(155deg,#6a5746,#4c3e30)',
  },
  {
    id: 'smoked',
    name: 'Smoked Olive',
    description: 'Grainy olive-taupe haze, soft and matte.',
    swatch:
      'radial-gradient(120% 130% at 60% 50%, rgba(60,56,42,0.7), transparent 60%),' +
      'linear-gradient(145deg,#97907c,#5c5847 70%,#454133)',
  },
  {
    id: 'linen',
    name: 'Pale Linen',
    description: 'Warm greige with a soft luminous sweep.',
    swatch:
      'radial-gradient(90% 80% at 70% 72%, #ece7d8, transparent 60%),' +
      'linear-gradient(158deg,#c2bba6,#d6cfbc 60%,#c5bda8)',
  },
  {
    id: 'tide',
    name: 'Deep Tide',
    description: 'Cool lagoon teal settling into the ocean dark.',
    swatch:
      'radial-gradient(120% 120% at 15% 0%, rgba(56,189,182,0.85), transparent 55%),' +
      'linear-gradient(155deg,#2d8a8f 0%,#134652 58%,#06141c 100%)',
  },
]

export const DEFAULT_THEME: ThemeId = 'ember'
const STORAGE_KEY = 'helm-theme'

const isTheme = (v: unknown): v is ThemeId =>
  THEMES.some((t) => t.id === v)

export function getStoredTheme(): ThemeId {
  if (typeof window === 'undefined') return DEFAULT_THEME
  const stored = window.localStorage.getItem(STORAGE_KEY)
  return isTheme(stored) ? stored : DEFAULT_THEME
}

/**
 * Read + persist the active home theme. Starts from the default on the server
 * and syncs to the stored value once mounted to avoid a hydration mismatch.
 */
export function useTheme(): [ThemeId, (id: ThemeId) => void] {
  const [theme, setThemeState] = useState<ThemeId>(DEFAULT_THEME)

  useEffect(() => {
    setThemeState(getStoredTheme())
  }, [])

  const setTheme = useCallback((id: ThemeId) => {
    setThemeState(id)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, id)
    }
  }, [])

  return [theme, setTheme]
}
