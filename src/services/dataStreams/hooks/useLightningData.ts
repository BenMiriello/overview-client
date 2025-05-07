import { useCallback, useRef } from 'react';
import { LightningStrike } from '../../../models/LightningStrike';
import { useWebSocket } from './useWebSocket';
import { DataStream } from '../interfaces';

interface UseLightningDataProps {
  url: string;
}

export function useLightningData({ url }: UseLightningDataProps) {
  const { connected, lastUpdate, subscribe } = useWebSocket({ url });
  const subscribersRef = useRef<Set<(data: LightningStrike) => void>>(new Set());

  const processData = useCallback((data: any): LightningStrike | null => {
    if (!data || typeof data !== 'object' || !data.id || 
        typeof data.lat === 'undefined' || typeof data.lng === 'undefined') {
      return null;
    }

    return {
      id: data.id,
      lat: data.lat,
      lng: data.lng,
      timestamp: data.timestamp,
      intensity: data.intensity,
      createdAt: Date.now()
    };
  }, []);

  const subscribeToLightning = useCallback((callback: (data: LightningStrike) => void) => {
    subscribersRef.current.add(callback);

    const unsubscribe = subscribe((rawData) => {
      const strike = processData(rawData);
      if (strike) {
        subscribersRef.current.forEach(subscriber => {
          try {
            subscriber(strike);
          } catch (error) {
            console.error('Error in lightning data subscriber:', error);
          }
        });
      }
    });

    return () => {
      subscribersRef.current.delete(callback);
      unsubscribe();
    };
  }, [subscribe, processData]);

  const dataStreamRef = useRef<DataStream<LightningStrike> | null>(null);

  if (!dataStreamRef.current) {
    dataStreamRef.current = {
      subscribe: subscribeToLightning,
      connect: () => {}, // No-op as connection is managed by useWebSocket hook
      disconnect: () => {}, // No-op as disconnection is managed by useWebSocket hook
      isConnected: () => connected,
      getLastUpdate: () => lastUpdate
    };
  }

  return {
    connected,
    lastUpdate,
    dataStream: dataStreamRef.current
  };
}
