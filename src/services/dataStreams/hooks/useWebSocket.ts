import { useState, useEffect, useRef, useCallback } from 'react';

import { WebSocketConfig as WSConfig } from '../interfaces';

export interface WebSocketConfig extends WSConfig {}

export type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting';

export interface UseWebSocketResult {
  connected: boolean;
  connectionStatus: ConnectionStatus;
  lastUpdate: string;
  send: (data: any) => void;
  subscribe: (callback: (data: any) => void) => () => void;
}

const HEARTBEAT_INTERVAL = 20_000;
const HEARTBEAT_TIMEOUT = 10_000;
const MIN_RECONNECT_DELAY = 1_000;
const MAX_RECONNECT_DELAY = 30_000;

export function useWebSocket({
  url,
}: WebSocketConfig): UseWebSocketResult {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [lastUpdate, setLastUpdate] = useState<string>('Never');
  const socketRef = useRef<WebSocket | null>(null);
  const subscribersRef = useRef<Set<(data: any) => void>>(new Set());
  const reconnectTimeoutRef = useRef<number | null>(null);
  const heartbeatIntervalRef = useRef<number | null>(null);
  const heartbeatTimeoutRef = useRef<number | null>(null);
  const lastUpdateTimeRef = useRef<number | null>(null);
  const reconnectDelayRef = useRef(MIN_RECONNECT_DELAY);
  const unmountedRef = useRef(false);

  const clearHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current !== null) {
      window.clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (heartbeatTimeoutRef.current !== null) {
      window.clearTimeout(heartbeatTimeoutRef.current);
      heartbeatTimeoutRef.current = null;
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (unmountedRef.current) return;
    if (reconnectTimeoutRef.current !== null) return;

    const delay = reconnectDelayRef.current;
    reconnectDelayRef.current = Math.min(delay * 2, MAX_RECONNECT_DELAY);

    setConnectionStatus('reconnecting');

    reconnectTimeoutRef.current = window.setTimeout(() => {
      reconnectTimeoutRef.current = null;
      connect();
    }, delay);
  }, []); // connect added below via ref pattern

  const connect = useCallback(() => {
    if (unmountedRef.current) return;
    if (socketRef.current?.readyState === WebSocket.OPEN) return;

    // Clean up any existing socket that isn't open
    if (socketRef.current) {
      socketRef.current.onclose = null;
      socketRef.current.onerror = null;
      socketRef.current.onmessage = null;
      socketRef.current.onopen = null;
      try { socketRef.current.close(); } catch (_) {}
      socketRef.current = null;
    }

    try {
      const socket = new WebSocket(url);

      socket.onopen = () => {
        if (unmountedRef.current) { socket.close(); return; }
        setConnectionStatus('connected');
        reconnectDelayRef.current = MIN_RECONNECT_DELAY;
        startHeartbeat();
      };

      socket.onclose = () => {
        if (unmountedRef.current) return;
        setConnectionStatus('disconnected');
        clearHeartbeat();
        scheduleReconnect();
      };

      socket.onmessage = (event) => {
        // Any message (including pong) resets the heartbeat timeout
        resetHeartbeatTimeout();

        try {
          const data = JSON.parse(event.data);

          // Application-level pong: don't forward to subscribers
          if (data.type === 'pong') return;

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

      socket.onerror = () => {
        // onclose will fire after this, which handles reconnect
      };

      socketRef.current = socket;
    } catch (error) {
      console.error('Failed to create WebSocket connection:', error);
      scheduleReconnect();
    }
  }, [url, clearHeartbeat, scheduleReconnect]);

  const forceReconnect = useCallback(() => {
    clearHeartbeat();
    if (socketRef.current) {
      socketRef.current.onclose = null;
      try { socketRef.current.close(); } catch (_) {}
      socketRef.current = null;
    }
    setConnectionStatus('disconnected');
    scheduleReconnect();
  }, [clearHeartbeat, scheduleReconnect]);

  const resetHeartbeatTimeout = useCallback(() => {
    if (heartbeatTimeoutRef.current !== null) {
      window.clearTimeout(heartbeatTimeoutRef.current);
    }
    heartbeatTimeoutRef.current = window.setTimeout(() => {
      console.warn('Heartbeat timeout - forcing reconnect');
      forceReconnect();
    }, HEARTBEAT_TIMEOUT);
  }, [forceReconnect]);

  const startHeartbeat = useCallback(() => {
    clearHeartbeat();
    heartbeatIntervalRef.current = window.setInterval(() => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: 'ping' }));
        resetHeartbeatTimeout();
      }
    }, HEARTBEAT_INTERVAL);
  }, [clearHeartbeat, resetHeartbeatTimeout]);

  const disconnect = useCallback(() => {
    clearHeartbeat();
    if (reconnectTimeoutRef.current !== null) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (socketRef.current) {
      socketRef.current.onclose = null;
      socketRef.current.close();
      socketRef.current = null;
    }
    setConnectionStatus('disconnected');
  }, [clearHeartbeat]);

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
    unmountedRef.current = false;
    connect();

    return () => {
      unmountedRef.current = true;
      disconnect();
    };
  }, [connect, disconnect]);

  return {
    connected: connectionStatus === 'connected',
    connectionStatus,
    lastUpdate,
    send,
    subscribe
  };
}
