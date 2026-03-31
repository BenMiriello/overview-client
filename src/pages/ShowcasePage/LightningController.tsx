import { useRef, useEffect, useCallback } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  LightningBoltEffect,
  LightningBoltEffectConfig,
  DetailLevel,
} from '../../effects/LightningBoltEffect';
import {
  TimelinePlayer,
  TimelinePlayerStatus,
  AtmosphereSnapshot,
  StrikeEvent,
  TimelineConfig,
} from '../../effects/LightningBoltEffect/simulation';
import { ChargeFieldRenderer } from '../../effects/LightningBoltEffect/rendering/ChargeFieldRenderer';

function getMaxMainChannelBrightness(
  segmentBrightness: Map<number, number>,
  mainChannelIds: Set<number>
): number {
  let maxBrightness = 0;
  for (const id of mainChannelIds) {
    const brightness = segmentBrightness.get(id) ?? 0;
    if (brightness > maxBrightness) {
      maxBrightness = brightness;
    }
  }
  return maxBrightness;
}

interface LightningControllerProps {
  detail?: number;
  speed?: number;
  windSpeed?: number;
  showCharge?: boolean;
  showAtmospheric?: boolean;
  showMoisture?: boolean;
  showIonization?: boolean;
}

const SHOWCASE_START = { x: 0, y: 1.5, z: 0 };
const SHOWCASE_END = { x: 0, y: -1.8, z: 0 };

// Convert knots to simulation units for VISIBLE movement
// Physics-accurate would be ~0.00008, but that's imperceptibly slow
// For visible drift (~15s to cross view at 60 kts), we need ~0.00145
const KTS_TO_SIM = 0.00145;

const LightningController = ({
  detail = 1.0,
  speed = 1.0,
  windSpeed = 25,
  showCharge = true,
  showAtmospheric = true,
  showMoisture = true,
  showIonization = true,
}: LightningControllerProps) => {
  const { scene, size, gl, camera } = useThree();

  // Timeline-based simulation (runs in worker, plays back pre-computed data)
  const playerRef = useRef<TimelinePlayer | null>(null);
  const atmosphereRendererRef = useRef<ChargeFieldRenderer | null>(null);
  const rendererInitializedRef = useRef(false);

  // Active strike
  const strikeRef = useRef<LightningBoltEffect | null>(null);

  // Refs for values that shouldn't trigger re-renders
  const speedRef = useRef(speed);
  const detailRef = useRef(detail);
  const windSpeedRef = useRef(windSpeed);
  const showChargeRef = useRef(showCharge);
  const showAtmosphericRef = useRef(showAtmospheric);
  const showMoistureRef = useRef(showMoisture);
  const showIonizationRef = useRef(showIonization);

  // Track if we've initialized
  const initializedRef = useRef(false);

  // Strike position for glow (world coords where strike lands)
  const strikePositionRef = useRef<{ x: number; z: number } | null>(null);

  // Afterglow state
  const afterglowRef = useRef<{
    startTime: number;
    position: { x: number; z: number };
  } | null>(null);
  const AFTERGLOW_DURATION_MS = 300;

  // Last frame time for delta calculation
  const lastTimeRef = useRef<number>(0);

  // Player status for debugging
  const playerStatusRef = useRef<TimelinePlayerStatus | null>(null);

  // Update refs when props change
  useEffect(() => {
    speedRef.current = speed;
    if (playerRef.current) {
      playerRef.current.setConfig({ speed });
    }
  }, [speed]);

  useEffect(() => {
    detailRef.current = detail;
    if (playerRef.current) {
      playerRef.current.setConfig({ detail });
    }
  }, [detail]);

  useEffect(() => {
    windSpeedRef.current = windSpeed;
    if (playerRef.current) {
      const baseWindSpeed = windSpeed * KTS_TO_SIM;
      playerRef.current.setConfig({ baseWindSpeed });
    }
  }, [windSpeed]);

  useEffect(() => {
    showChargeRef.current = showCharge;
    if (atmosphereRendererRef.current) {
      atmosphereRendererRef.current.setCeilingVisible(showCharge);
      atmosphereRendererRef.current.setGroundVisible(showCharge);
    }
  }, [showCharge]);

  useEffect(() => {
    showAtmosphericRef.current = showAtmospheric;
    if (atmosphereRendererRef.current) {
      atmosphereRendererRef.current.setAtmosphericVisible(showAtmospheric);
    }
  }, [showAtmospheric]);

  useEffect(() => {
    showMoistureRef.current = showMoisture;
    if (atmosphereRendererRef.current) {
      atmosphereRendererRef.current.setMoistureVisible(showMoisture);
    }
  }, [showMoisture]);

  useEffect(() => {
    showIonizationRef.current = showIonization;
    if (atmosphereRendererRef.current) {
      atmosphereRendererRef.current.setIonizationVisible(showIonization);
    }
  }, [showIonization]);

  // Handle strike events from the timeline player
  const handleStrike = useCallback(
    (event: StrikeEvent) => {
      if (strikeRef.current) {
        strikeRef.current.terminate();
        strikeRef.current = null;
      }

      const offsetX = event.breakdownPosition.x;
      const offsetZ = event.breakdownPosition.z;

      const config: LightningBoltEffectConfig = {
        lat: 0,
        lng: 0,
        startAltitude: 1.0,
        groundAltitude: 0,
        resolution: detailRef.current,
        seed: event.seed,
        enableScreenFlash: true,
        duration: 1.5,
        fadeTime: 0.3,
        detailLevel: DetailLevel.SHOWCASE,
        worldStart: { x: offsetX, y: SHOWCASE_START.y, z: offsetZ },
        worldEnd: {
          x: offsetX * 0.3,
          y: SHOWCASE_END.y,
          z: offsetZ * 0.3,
        },
        speed: speedRef.current,
        skipChargeRendering: true,
        precomputedResult: { geometry: event.geometry, stats: { totalSteps: 0, segmentCount: 0, branchCount: 0, maxDepth: 0, connected: true, elapsedMs: 0 } },
      };

      const strike = new LightningBoltEffect(scene, null, config);
      strike.updateResolution(size.width, size.height);
      strikeRef.current = strike;

      console.log('[LightningController] Strike from pre-computed timeline');

      // Get ACTUAL landing position from the simulated bolt (in world space)
      const landingPos = strike.getStrikeLandingPosition();
      if (landingPos) {
        strikePositionRef.current = { x: landingPos.x, z: landingPos.z };
      } else {
        strikePositionRef.current = {
          x: offsetX * 0.3,
          z: offsetZ * 0.3,
        };
      }
    },
    [scene, size.width, size.height]
  );

  // Handle snapshot updates from the timeline player
  const handleSnapshot = useCallback((snapshot: AtmosphereSnapshot) => {
    if (!atmosphereRendererRef.current) return;

    // Initialize renderer on first snapshot if not done yet
    if (!rendererInitializedRef.current) {
      atmosphereRendererRef.current.initializeFromSnapshot(
        snapshot,
        SHOWCASE_START,
        SHOWCASE_END
      );
      rendererInitializedRef.current = true;

      // Visibility is managed by the useEffect hooks for each layer.
      // The ChargeFieldRenderer defaults all layers to visible=true.
      // useEffects will apply the correct localStorage-driven state
      // after the next React render cycle.
    } else {
      atmosphereRendererRef.current.updateFromSnapshot(snapshot);
    }
  }, []);

  // Handle player status changes
  const handleStatusChange = useCallback((status: TimelinePlayerStatus) => {
    playerStatusRef.current = status;

    // Log periodically for debugging
    if (Math.random() < 0.01) {
      console.log(
        `[TimelinePlayer] lead=${status.leadTimeMs.toFixed(0)}ms, speed=${status.playbackSpeed.toFixed(2)}x, visual=${status.visualTimeMs.toFixed(0)}ms`
      );
    }
  }, []);

  // Initialize timeline player
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    // Create atmosphere renderer (sprites will be created on first snapshot)
    atmosphereRendererRef.current = new ChargeFieldRenderer(scene, {
      planeSize: 1.0,
      opacity: 0.15,
    });

    // Create timeline player with callbacks
    playerRef.current = new TimelinePlayer({
      onSnapshot: handleSnapshot,
      onStrike: handleStrike,
      onStatusChange: handleStatusChange,
    });

    // Start the player with initial config
    const initialConfig: Partial<TimelineConfig> = {
      speed: speedRef.current,
      detail: detailRef.current,
      baseWindSpeed: windSpeedRef.current * KTS_TO_SIM,
      chargeAccumulationRate: 0.15,
      breakdownThreshold: 0.75,
    };
    playerRef.current.start(initialConfig);

    lastTimeRef.current = performance.now();

    return () => {
      if (strikeRef.current) {
        strikeRef.current.terminate();
        strikeRef.current = null;
      }
      if (atmosphereRendererRef.current) {
        atmosphereRendererRef.current.dispose();
        atmosphereRendererRef.current = null;
      }
      if (playerRef.current) {
        playerRef.current.stop();
        playerRef.current = null;
      }
      initializedRef.current = false;
      rendererInitializedRef.current = false;
    };
  }, [scene, handleSnapshot, handleStrike, handleStatusChange]);

  // Resolution updates
  useEffect(() => {
    if (strikeRef.current) {
      strikeRef.current.updateResolution(size.width, size.height);
    }
  }, [size.width, size.height]);

  // Main update loop
  useFrame(() => {
    const now = performance.now();

    // Update timeline player (fetches snapshots/events, calls callbacks)
    if (playerRef.current) {
      playerRef.current.update();
    }

    // Render low-res volumetrics
    if (atmosphereRendererRef.current?.isLowResEnabled()) {
      atmosphereRendererRef.current.renderVolumetrics(gl, camera);
    }

    // Update active strike and dispatch glow updates
    if (strikeRef.current) {
      strikeRef.current.update(now);

      // Get animation state for glow synchronization
      const animState = strikeRef.current.getAnimationState(now);
      if (animState && strikePositionRef.current) {
        // Use ACTUAL segment brightness from the animation, not arbitrary curves
        const intensity = getMaxMainChannelBrightness(
          animState.segmentBrightness,
          animState.mainChannelIds
        );
        window.dispatchEvent(
          new CustomEvent('lightning-glow-update', {
            detail: { intensity, position: strikePositionRef.current },
          })
        );
      }

      if (strikeRef.current.isComplete()) {
        // Start afterglow
        if (strikePositionRef.current) {
          afterglowRef.current = {
            startTime: now,
            position: { ...strikePositionRef.current },
          };
        }

        strikeRef.current.terminate();
        strikeRef.current = null;
        strikePositionRef.current = null;
      }
    }

    // Handle afterglow
    if (!strikeRef.current && afterglowRef.current) {
      const elapsed = now - afterglowRef.current.startTime;
      if (elapsed < AFTERGLOW_DURATION_MS) {
        const progress = elapsed / AFTERGLOW_DURATION_MS;
        const intensity = 0.1 * (1 - progress);
        window.dispatchEvent(
          new CustomEvent('lightning-glow-update', {
            detail: { intensity, position: afterglowRef.current.position },
          })
        );
      } else {
        // Afterglow complete
        window.dispatchEvent(
          new CustomEvent('lightning-glow-update', {
            detail: { intensity: 0, position: null },
          })
        );
        afterglowRef.current = null;
      }
    }
  });

  return null;
};

export default LightningController;
