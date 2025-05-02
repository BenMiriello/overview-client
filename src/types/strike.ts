interface Station {
  sta: number;
  time: number;
  lat: number;
  lon: number;
  alt: number;
  status: number;
}

export default interface Strike {
  id: string;
  lat: number;
  lon: number;
  timestamp: number;
  time?: number;
  pol?: number;
  sig?: Station[] | number;
  region?: number;
  reg?: number;
  sta?: number;
  mds?: number;
  mcg?: number;
  alt?: number;
  status?: number;
  delay?: number;
  lonc?: number;
  latc?: number;
}
