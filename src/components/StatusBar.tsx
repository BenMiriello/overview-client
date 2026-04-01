import React from 'react';
import { LightningLayer } from '../layers';
import { ConnectionStatus } from '../services/dataStreams/hooks';

interface StatusBarProps {
  connected: boolean;
  connectionStatus: ConnectionStatus;
  lastUpdate: string;
  lightningLayer: LightningLayer | null;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  connectionStatus,
  lastUpdate,
  lightningLayer
}) => {
  if (connectionStatus === 'connected') {
    return (
      <div className="status-bar">
        Connected |
        Lightning Effects: {lightningLayer?.getActiveLightningBoltCount() || 0} |
        Markers: {lightningLayer?.getMarkerCount() || 0} |
        Last update: {lastUpdate}
      </div>
    );
  }

  if (connectionStatus === 'reconnecting') {
    return (
      <div className="status-bar warning">
        Reconnecting to server...
      </div>
    );
  }

  return (
    <div className="status-bar error">
      Disconnected from server
    </div>
  );
};
