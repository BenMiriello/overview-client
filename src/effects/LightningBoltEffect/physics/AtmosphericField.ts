export interface ElectricField {
  electricPotential: number;
  conductivity: number;
  breakdownThreshold: number;
}

export interface FieldPoint {
  x: number;
  y: number; 
  z: number;
  field: ElectricField;
}

export class AtmosphericField {
  private field: Map<string, ElectricField> = new Map();
  private seed: number;

  constructor(seed: number = Date.now()) {
    this.seed = seed;
  }

  private hash(x: number, y: number, z: number): string {
    const scale = 100;
    return `${Math.floor(x * scale)},${Math.floor(y * scale)},${Math.floor(z * scale)}`;
  }

  private noise3D(x: number, y: number, z: number): number {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;

    const u = this.fade(x - Math.floor(x));
    const v = this.fade(y - Math.floor(y));
    const w = this.fade(z - Math.floor(z));

    const A = this.p[X] + Y;
    const AA = this.p[A] + Z;
    const AB = this.p[A + 1] + Z;
    const B = this.p[X + 1] + Y;
    const BA = this.p[B] + Z;
    const BB = this.p[B + 1] + Z;

    return this.lerp(w,
      this.lerp(v,
        this.lerp(u, this.grad(this.p[AA], x, y, z), this.grad(this.p[BA], x - 1, y, z)),
        this.lerp(u, this.grad(this.p[AB], x, y - 1, z), this.grad(this.p[BB], x - 1, y - 1, z))
      ),
      this.lerp(v,
        this.lerp(u, this.grad(this.p[AA + 1], x, y, z - 1), this.grad(this.p[BA + 1], x - 1, y, z - 1)),
        this.lerp(u, this.grad(this.p[AB + 1], x, y - 1, z - 1), this.grad(this.p[BB + 1], x - 1, y - 1, z - 1))
      )
    );
  }

  private fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  private lerp(t: number, a: number, b: number): number {
    return a + t * (b - a);
  }

  private grad(hash: number, x: number, y: number, z: number): number {
    const h = hash & 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  }

  private p: number[] = (() => {
    const p = new Array(512);
    const permutation = Array.from({length: 256}, (_, i) => i);

    for (let i = 255; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [permutation[i], permutation[j]] = [permutation[j], permutation[i]];
    }

    for (let i = 0; i < 256; i++) {
      p[i] = p[i + 256] = permutation[i];
    }
    return p;
  })();

  getField(x: number, y: number, z: number): ElectricField {
    const key = this.hash(x, y, z);

    if (!this.field.has(key)) {
      const baseAltitude = y;
      const distanceFromCenter = Math.sqrt(x * x + z * z);

      const humidityNoise = this.noise3D(x * 0.05, y * 0.05, z * 0.05);
      const ionizationNoise = this.noise3D(x * 0.1 + 100, y * 0.1, z * 0.1 + 100);

      const baseField = 1.0 - baseAltitude * 0.5;
      const localVariation = humidityNoise * 0.3 + ionizationNoise * 0.2;

      this.field.set(key, {
        electricPotential: baseField + localVariation,
        conductivity: 0.7 + humidityNoise * 0.3,
        breakdownThreshold: 0.8 - ionizationNoise * 0.2
      });
    }

    return this.field.get(key)!;
  }

  shouldBranch(point: FieldPoint): boolean {
    const field = point.field;
    const branchPotential = field.electricPotential * field.conductivity;
    return branchPotential > field.breakdownThreshold;
  }
}
