/**
 * Generic interface for data streams
 */
export interface DataStream<T> {
  connect(): void;
  disconnect(): void;
  isConnected(): boolean;
  subscribe(callback: (data: T) => void): () => void;
  getLastUpdate(): string;
}

/**
 * Basic configuration for WebSocket connections
 */
export interface WebSocketConfig {
  url: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}
