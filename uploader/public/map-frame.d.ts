export function mapFrame(runs: readonly (readonly (readonly [number, number])[])[]): {
  bounds: [[number, number], [number, number]] | null;
  longitude(lng: number): number;
};
