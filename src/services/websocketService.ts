import { useState, useEffect, useCallback } from 'react';
import { LightningStrike } from '../models/LightningStrike';

interface WebSocketServiceProps {
  url: string;
  onNewStrike: (strike: LightningStrike) => void;
}

interface WebSocketHookReturn {
  connected: boolean;
  lastUpdate: string;
}

export const useWebSocketService = ({ url, onNewStrike }: WebSocketServiceProps): WebSocketHookReturn => {
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState('');

  const createStrike = useCallback((data: any): LightningStrike => {
    return {
      id: data.id,
      lat: data.lat,
      lng: data.lng,
      timestamp: data.timestamp,
      createdAt: Date.now()
    };
  }, []);

  useEffect(() => {
    console.log('Connecting to WebSocket server at:', url);
    const ws = new WebSocket(url);
    
    ws.onopen = () => {
      console.log('Connected to server');
      setConnected(true);
    };

    ws.onclose = () => {
      console.log('Disconnected from server');
      setConnected(false);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.id && (data.lat !== undefined) && (data.lng !== undefined)) {          
          const newStrike = createStrike(data);
          onNewStrike(newStrike);
        }

        setLastUpdate(new Date().toLocaleTimeString());
      } catch (error) {
        console.error('Error parsing data:', error);
      }
    };

    return () => {
      console.log('Closing WebSocket connection');
      ws.close();
    };
  }, [url, onNewStrike, createStrike]);

  return { connected, lastUpdate };
};
