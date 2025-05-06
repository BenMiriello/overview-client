import React from 'react';
import { LightningLayer } from '../layers';

interface StatusBarProps {
  connected: boolean;
  strikesCount: number;
  lastUpdate: string;
  lightningLayer: LightningLayer | null;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  connected,
  strikesCount,
  lastUpdate,
  lightningLayer
}) => {
  if (connected) {
    return (
      <div className="status-bar">
        Connected | Strikes: {strikesCount} | 
        Lightning Effects: {lightningLayer?.getActiveZigZagCount() || 0} | 
        Markers: {lightningLayer?.getMarkerCount() || 0} | 
        Last update: {lastUpdate}
      </div>
    );
  } else {
    return (
      <div className="status-bar error">
        Disconnected from server
      </div>
    );
  }
};
