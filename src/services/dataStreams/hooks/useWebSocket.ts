import { useState, useEffect, useRef, useCallback } from 'react';

import { WebSocketConfig as WSConfig } from '../interfaces';

export interface WebSocketConfig extends WSConfig {}

export interface UseWebSocketResult {
  connected: boolean;
  lastUpdate: string;
  send: (data: any) => void;
  subscribe: (callback: (data: any) => void) => () => void;
}

export function useWebSocket({
  url,
  reconnectInterval = 3000,
  maxReconnectAttempts = 5
}: WebSocketConfig): UseWebSocketResult {
  const [connected, setConnected] = useState<boolean>(false);
  const [lastUpdate, setLastUpdate] = useState<string>('Never');
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef<number>(0);
  const subscribersRef = useRef<Set<(data: any) => void>>(new Set());
  const reconnectTimeoutRef = useRef<number | null>(null);
  const lastUpdateTimeRef = useRef<number | null>(null);

  const connect = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const socket = new WebSocket(url);

      socket.onopen = () => {
        setConnected(true);
        reconnectAttemptsRef.current = 0;
      };

      socket.onclose = () => {
        setConnected(false);

        if (reconnectAttemptsRef.current < maxReconnectAttempts) {
          reconnectAttemptsRef.current += 1;

          if (reconnectTimeoutRef.current !== null) {
            window.clearTimeout(reconnectTimeoutRef.current);
          }

          reconnectTimeoutRef.current = window.setTimeout(() => {
            connect();
          }, reconnectInterval);
        }
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          // Only update lastUpdate once per second maximum
          const now = Date.now();
          if (!lastUpdateTimeRef.current || now - lastUpdateTimeRef.current > 1000) {
            setLastUpdate(new Date().toLocaleTimeString());
            lastUpdateTimeRef.current = now;
          }

          subscribersRef.current.forEach(subscriber => {
            try {
              subscriber(data);
            } catch (error) {
              console.error('Error in WebSocket subscriber:', error);
            }
          });
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      };

      socket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      socketRef.current = socket;
    } catch (error) {
      console.error('Failed to create WebSocket connection:', error);
    }
  }, [url, reconnectInterval, maxReconnectAttempts]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current !== null) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.close();
    }
  }, []);

  const send = useCallback((data: any) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(typeof data === 'string' ? data : JSON.stringify(data));
    }
  }, []);

  const subscribe = useCallback((callback: (data: any) => void) => {
    subscribersRef.current.add(callback);

    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      connect();
    }

    return () => {
      subscribersRef.current.delete(callback);

      if (subscribersRef.current.size === 0) {
        disconnect();
      }
    };
  }, [connect, disconnect]);

  useEffect(() => {
    connect();

    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  return {
    connected,
    lastUpdate,
    send,
    subscribe
  };
}
