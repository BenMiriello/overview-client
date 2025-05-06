import { useCallback } from 'react';
import { useWebSocketDataStream } from './useWebSocketDataStream';
import { LightningStrike } from '../../models/LightningStrike';

interface LightningDataStreamProps {
  url: string;
  onNewStrike: (strike: LightningStrike) => void;
}

export function useLightningDataStream({ url, onNewStrike }: LightningDataStreamProps) {
  const transformStrike = useCallback((data: any): LightningStrike => {
    return {
      id: data.id,
      lat: data.lat,
      lng: data.lng,
      timestamp: data.timestamp,
      createdAt: Date.now()
    };
  }, []);

  const validateStrikeData = useCallback((data: any): boolean => {
    return data.id && (data.lat !== undefined) && (data.lng !== undefined);
  }, []);

  const handleData = useCallback((rawData: any) => {
    if (validateStrikeData(rawData)) {
      onNewStrike(rawData);
    }
  }, [validateStrikeData, onNewStrike]);

  return useWebSocketDataStream<LightningStrike>({
    url,
    onData: handleData,
    transformData: transformStrike
  });
}
