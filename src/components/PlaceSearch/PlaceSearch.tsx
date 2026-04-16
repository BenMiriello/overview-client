import { useState, useRef, useCallback, useEffect, KeyboardEvent } from 'react';
import { Search, LocateFixed } from 'lucide-react';
import { usePlaceSearch, Place } from '../../hooks/usePlaceSearch';
import './PlaceSearch.css';

const ALTITUDE_BY_TYPE: Record<Place['type'], number> = {
  country: 0.3,
  region: 0.15,
  city: 0.05,
};

interface PlaceSearchProps {
  onFlyTo: (lat: number, lng: number, altitude: number) => void;
}

type LocateState = 'idle' | 'locating' | 'error';

const PlaceSearch: React.FC<PlaceSearchProps> = ({ onFlyTo }) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [locateState, setLocateState] = useState<LocateState>('idle');

  const results = usePlaceSearch(query);
  const barRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const mouseInZoneRef = useRef(false);

  function handleZoneEnter() {
    mouseInZoneRef.current = true;
    clearTimeout(leaveTimerRef.current);
    setIsOpen(true);
  }

  function handleZoneLeave() {
    mouseInZoneRef.current = false;
    clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = setTimeout(() => {
      if (document.activeElement !== inputRef.current) {
        setIsOpen(false);
      }
    }, 300);
  }

  // Collapse when input loses focus while mouse is away
  function handleInputBlur() {
    if (!mouseInZoneRef.current) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = setTimeout(() => setIsOpen(false), 300);
    }
  }

  useEffect(() => {
    return () => clearTimeout(leaveTimerRef.current);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  useEffect(() => {
    if (results.length > 0) {
      setDropdownOpen(true);
      setActiveIndex(0);
    } else {
      setDropdownOpen(false);
    }
  }, [results]);

  const selectPlace = useCallback((place: Place) => {
    onFlyTo(place.lat, place.lng, ALTITUDE_BY_TYPE[place.type]);
    setQuery('');
    setDropdownOpen(false);
    inputRef.current?.blur();
  }, [onFlyTo]);

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!dropdownOpen || results.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = results[activeIndex] ?? results[0];
      if (target) selectPlace(target);
    } else if (e.key === 'Escape') {
      setDropdownOpen(false);
      inputRef.current?.blur();
    }
  }

  function handleLocate() {
    if (locateState === 'locating') return;
    setLocateState('locating');
    navigator.geolocation.getCurrentPosition(
      pos => {
        setLocateState('idle');
        onFlyTo(pos.coords.latitude, pos.coords.longitude, 0.05);
      },
      () => {
        setLocateState('error');
        setTimeout(() => setLocateState('idle'), 2000);
      }
    );
  }

  function subLabel(place: Place): string {
    if (place.type === 'country') return 'Country';
    return place.country;
  }

  return (
    <div
      className="place-search-zone"
      onMouseEnter={handleZoneEnter}
      onMouseLeave={handleZoneLeave}
    >
      <div ref={barRef} className={`place-search${isOpen ? ' open' : ''}`}>
        <div className="place-search-bar" onClick={() => inputRef.current?.focus()}>
          <span className="place-search-bar-icon">
            <Search size={16} />
          </span>
          <input
            ref={inputRef}
            className="place-search-bar-input"
            type="text"
            placeholder="Search places..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => { if (results.length > 0) setDropdownOpen(true); }}
            onBlur={handleInputBlur}
            autoComplete="off"
            spellCheck={false}
          />
          {dropdownOpen && results.length > 0 && (
            <div className="place-search-dropdown">
              {results.map((place, i) => (
                <div
                  key={`${place.name}-${place.countryCode}-${i}`}
                  className={`place-search-result${i === activeIndex ? ' active' : ''}`}
                  onPointerDown={e => { e.preventDefault(); selectPlace(place); }}
                >
                  <span className="place-search-result-name">{place.name}</span>
                  <span className="place-search-result-sub">{subLabel(place)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <button
          className={`place-search-locate-btn${locateState !== 'idle' ? ` ${locateState}` : ''}`}
          onClick={handleLocate}
          aria-label="Go to my location"
          title="Go to my location"
        >
          <LocateFixed size={18} />
        </button>
      </div>
    </div>
  );
};

export default PlaceSearch;
