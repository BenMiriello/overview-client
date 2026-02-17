import { useRef, useEffect, useCallback } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { LightningBoltEffect, LightningBoltEffectConfig, DetailLevel } from '../../effects/LightningBoltEffect';
import { AtmosphereSimulator, BreakdownEvent } from '../../effects/LightningBoltEffect/simulation/AtmosphereSimulator';
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
  showCharge?: boolean;
  showAtmospheric?: boolean;
  showMoisture?: boolean;
  showIonization?: boolean;
}

const SHOWCASE_START = { x: 0, y: 1.5, z: 0 };
const SHOWCASE_END = { x: 0, y: -1.8, z: 0 };

const LightningController = ({
  detail = 1.0,
  speed = 1.0,
  showCharge = true,
  showAtmospheric = true,
  showMoisture = true,
  showIonization = true,
}: LightningControllerProps) => {
  const { scene, size } = useThree();

  // Persistent atmosphere simulation
  const simulatorRef = useRef<AtmosphereSimulator | null>(null);
  const atmosphereRendererRef = useRef<ChargeFieldRenderer | null>(null);

  // Active strike
  const strikeRef = useRef<LightningBoltEffect | null>(null);

  // Refs for values that shouldn't trigger re-renders
  const speedRef = useRef(speed);
  const showChargeRef = useRef(showCharge);
  const showAtmosphericRef = useRef(showAtmospheric);
  const showMoistureRef = useRef(showMoisture);
  const showIonizationRef = useRef(showIonization);

  // Track if we've initialized
  const initializedRef = useRef(false);

  // Last frame time for delta calculation
  const lastTimeRef = useRef<number>(0);

  // Cooldown after strike to prevent immediate re-trigger
  const strikeCooldownRef = useRef<number>(0);
  const STRIKE_COOLDOWN_MS = 500;

  // Strike position for glow (world coords where strike lands)
  const strikePositionRef = useRef<{ x: number; z: number } | null>(null);

  // Afterglow state
  const afterglowRef = useRef<{ startTime: number; position: { x: number; z: number } } | null>(null);
  const AFTERGLOW_DURATION_MS = 300;

  // Update refs when props change
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

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

  // Initialize persistent atmosphere system
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    const seed = Math.random() * 0xffffffff;

    // Create persistent simulator
    simulatorRef.current = new AtmosphereSimulator(seed, {
      chargeAccumulationRate: 0.18,
      breakdownThreshold: 0.80,
      postStrikeChargeFactor: 0.15,
      baseWindSpeed: 0.002,
      windDirection: { x: 0.8, z: 0.6 },
      ceilingY: 0.5,
      groundY: -0.5,
      initialChargeRange: [0.5, 0.7],
    });

    // Create persistent atmosphere renderer
    atmosphereRendererRef.current = new ChargeFieldRenderer(scene, {
      planeSize: 1.0,
      opacity: 0.2,
    });

    // Initialize renderer from simulator
    atmosphereRendererRef.current.initialize(simulatorRef.current, SHOWCASE_START, SHOWCASE_END);

    // Apply initial visibility settings
    atmosphereRendererRef.current.setCeilingVisible(showChargeRef.current);
    atmosphereRendererRef.current.setGroundVisible(showChargeRef.current);
    atmosphereRendererRef.current.setAtmosphericVisible(showAtmosphericRef.current);
    atmosphereRendererRef.current.setMoistureVisible(showMoistureRef.current);
    atmosphereRendererRef.current.setIonizationVisible(showIonizationRef.current);

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
      simulatorRef.current = null;
      initializedRef.current = false;
    };
  }, [scene]);

  const createStrikeAt = useCallback(
    (breakdownEvent: BreakdownEvent) => {
      if (strikeRef.current) {
        strikeRef.current.terminate();
        strikeRef.current = null;
      }

      if (!simulatorRef.current) return;

      // Get current atmosphere snapshot for the simulation
      const atmosphere = simulatorRef.current.getAtmosphericModel();

      // Offset the strike position based on breakdown location
      const offsetX = breakdownEvent.position.x;
      const offsetZ = breakdownEvent.position.z;

      const config: LightningBoltEffectConfig = {
        lat: 0,
        lng: 0,
        startAltitude: 1.0,
        groundAltitude: 0,
        resolution: detail,
        seed: Math.random() * 0xffffffff,
        enableScreenFlash: true,
        duration: 1.5,
        fadeTime: 0.3,
        detailLevel: DetailLevel.SHOWCASE,
        worldStart: { x: offsetX, y: SHOWCASE_START.y, z: offsetZ },
        worldEnd: { x: offsetX * 0.3, y: SHOWCASE_END.y, z: offsetZ * 0.3 },
        speed: speedRef.current,
        atmosphere: atmosphere,
        skipChargeRendering: true, // We use our own persistent renderer
      };

      const strike = new LightningBoltEffect(scene, null, config);
      strike.updateResolution(size.width, size.height);
      strikeRef.current = strike;

      // Get ACTUAL landing position from the simulated bolt (in world space)
      const landingPos = strike.getStrikeLandingPosition();
      if (landingPos) {
        strikePositionRef.current = { x: landingPos.x, z: landingPos.z };
      } else {
        // Fallback to configured end position
        strikePositionRef.current = { x: offsetX * 0.3, z: offsetZ * 0.3 };
      }

      // Set cooldown
      strikeCooldownRef.current = performance.now() + STRIKE_COOLDOWN_MS;
    },
    [scene, size.width, size.height, detail]
  );

  // Resolution updates
  useEffect(() => {
    if (strikeRef.current) {
      strikeRef.current.updateResolution(size.width, size.height);
    }
  }, [size.width, size.height]);

  // Main update loop
  useFrame(() => {
    const now = performance.now();
    const dt = Math.min((now - lastTimeRef.current) / 1000, 0.1) * speedRef.current; // Cap delta, apply speed
    lastTimeRef.current = now;

    // Update atmosphere simulation
    let breakdownEvent: BreakdownEvent | null = null;
    if (simulatorRef.current) {
      breakdownEvent = simulatorRef.current.update(dt);

      // Update atmosphere visualization
      if (atmosphereRendererRef.current) {
        atmosphereRendererRef.current.updateFromSimulator(simulatorRef.current);
      }
    }

    // Update active strike and dispatch glow updates
    if (strikeRef.current) {
      strikeRef.current.update(now);

      // Get animation state for glow synchronization
      const animState = strikeRef.current.getAnimationState(now);
      if (animState && strikePositionRef.current) {
        // Use ACTUAL segment brightness from the animation, not arbitrary curves
        const intensity = getMaxMainChannelBrightness(animState.segmentBrightness, animState.mainChannelIds);
        window.dispatchEvent(
          new CustomEvent('lightning-glow-update', {
            detail: { intensity, position: strikePositionRef.current },
          })
        );
      }

      if (strikeRef.current.isComplete()) {
        // Notify simulator about strike completion for charge dissipation
        if (simulatorRef.current) {
          const strikePos = strikeRef.current.getStrikeStartPosition();
          if (strikePos) {
            simulatorRef.current.onStrikeComplete(strikePos, 0.2);
          }
        }

        // Start afterglow
        if (strikePositionRef.current) {
          afterglowRef.current = { startTime: now, position: { ...strikePositionRef.current } };
        }

        strikeRef.current.terminate();
        strikeRef.current = null;
        strikePositionRef.current = null;

        // Reset cooldown after strike ends
        strikeCooldownRef.current = now + STRIKE_COOLDOWN_MS;
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

    // Trigger new strike from breakdown (if not in cooldown and no active strike)
    if (!strikeRef.current && breakdownEvent && now > strikeCooldownRef.current) {
      createStrikeAt(breakdownEvent);
    }
  });

  return null;
};

export default LightningController;
