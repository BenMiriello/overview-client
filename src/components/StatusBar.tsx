import React from 'react';
import { LightningLayer } from '../layers';

interface StatusBarProps {
  connected: boolean;
  lastUpdate: string;
  lightningLayer: LightningLayer | null;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  connected,
  lastUpdate,
  lightningLayer
}) => {
  if (connected) {
    return (
      <div className="status-bar">
        Connected |
        Lightning Effects: {lightningLayer?.getActiveLightningBoltCount() || 0} |
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
