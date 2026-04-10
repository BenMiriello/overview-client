const STORAGE_KEY = 'globe_view';
const LEGACY_PREFER_3D_KEY = 'globe_prefer3D';

export interface FarSnapshot {
  lat: number;
  lng: number;
  altitude: number;
}

export interface CloseSnapshot {
  targetLat: number;
  targetLng: number;
  altitude: number;
  heading: number;
  pitch: number;
}

export interface MoonSnapshot {
  theta: number;
  phi: number;
  distance: number;
}

export interface MoonCloseSnapshot {
  targetLat: number;
  targetLng: number;
  altitude: number;
  heading: number;
  pitch: number;
}

export interface StoredView {
  version: 1;
  viewTarget: 'earth' | 'moon';
  is3D: boolean;
  isOrbiting: boolean;
  cloudsEnabled?: boolean;
  mode: 'far' | 'close' | 'moon' | 'moonClose';
  far?: FarSnapshot;
  close?: CloseSnapshot;
  moon?: MoonSnapshot;
  moonClose?: MoonCloseSnapshot;
}

export function loadView(): StoredView | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1) return null;
    return parsed as StoredView;
  } catch {
    return null;
  }
}

export function loadLegacyPrefer3D(): boolean | null {
  try {
    const v = localStorage.getItem(LEGACY_PREFER_3D_KEY);
    if (v === null) return null;
    return v !== 'false';
  } catch {
    return null;
  }
}

export function saveView(view: StoredView): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(view));
  } catch {
    // localStorage unavailable
  }
}
