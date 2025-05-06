import { useState, useEffect, useCallback } from 'react';
import { DataStream, DataStreamConfig } from './interfaces';

interface WebSocketDataStreamProps<T> extends DataStreamConfig {
  onData: (data: T) => void;
  transformData: (rawData: any) => T;
}

interface WebSocketDataStreamState {
  connected: boolean;
  lastUpdate: string;
}

export function useWebSocketDataStream<T>({
  url,
  onData,
  transformData,
  reconnectInterval = 5000,
  maxReconnectAttempts = 5
}: WebSocketDataStreamProps<T>): DataStream<T> & WebSocketDataStreamState {
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState('');
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [reconnectCount, setReconnectCount] = useState(0);

  const connect = useCallback(() => {
    if (socket !== null) return;
    
    const ws = new WebSocket(url);
    
    ws.onopen = () => {
      console.log('Connected to data stream at:', url);
      setConnected(true);
      setReconnectCount(0);
    };

    ws.onclose = () => {
      console.log('Disconnected from data stream');
      setConnected(false);
      setSocket(null);
      
      // Try to reconnect if not at max attempts
      if (reconnectCount < maxReconnectAttempts) {
        setTimeout(() => {
          setReconnectCount(prev => prev + 1);
          connect();
        }, reconnectInterval);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    ws.onmessage = (event) => {
      try {
        const rawData = JSON.parse(event.data);
        const processedData = transformData(rawData);
        onData(processedData);
        setLastUpdate(new Date().toLocaleTimeString());
      } catch (error) {
        console.error('Error processing data:', error);
      }
    };
    
    setSocket(ws);
  }, [url, onData, transformData, reconnectCount, reconnectInterval, maxReconnectAttempts, socket]);

  const disconnect = useCallback(() => {
    if (socket) {
      socket.close();
      setSocket(null);
    }
  }, [socket]);

  useEffect(() => {
    connect();
    
    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  return {
    connect,
    disconnect,
    isConnected: () => connected,
    getLastUpdate: () => lastUpdate,
    connected,
    lastUpdate
  };
}
