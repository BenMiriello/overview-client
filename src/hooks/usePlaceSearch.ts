import { useState, useEffect } from 'react';

export interface Place {
  name: string;
  lat: number;
  lng: number;
  countryCode: string;
  country: string;
  type: 'city' | 'country' | 'region';
  population: number;
}

let placesCache: Place[] | null = null;

async function loadPlaces(): Promise<Place[]> {
  if (placesCache) return placesCache;
  const res = await fetch('/data/places.json');
  placesCache = (await res.json()) as Place[];
  return placesCache;
}

export function usePlaceSearch(query: string, debounceMs = 350): Place[] {
  const [results, setResults] = useState<Place[]>([]);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      const places = await loadPlaces();
      const q = query.toLowerCase();

      // Exact prefix matches rank above mid-string matches
      const prefix: Place[] = [];
      const contains: Place[] = [];

      for (const p of places) {
        const n = p.name.toLowerCase();
        if (n.startsWith(q)) prefix.push(p);
        else if (n.includes(q)) contains.push(p);
      }

      // Each group is already population-sorted from the build step
      setResults([...prefix, ...contains].slice(0, 8));
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [query, debounceMs]);

  return results;
}
