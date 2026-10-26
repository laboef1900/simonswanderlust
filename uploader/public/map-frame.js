// Display only: input runs are already split at the antimeridian. Never persist
// these world-copy longitudes or use this helper in the public projection pipeline.
export function mapFrame(runs) {
  const intervals = [];
  let south = Infinity, north = -Infinity;
  for (const run of runs) {
    let west = Infinity, east = -Infinity;
    for (const [lng, lat] of run) {
      west = Math.min(west, lng); east = Math.max(east, lng);
      south = Math.min(south, lat); north = Math.max(north, lat);
    }
    if (west !== Infinity) intervals.push([west, east]);
  }
  if (!intervals.length) return { bounds: null, longitude: (lng) => lng };
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
    else merged.push(interval);
  }
  // Start with the ordinary extent: ties retain the conventional world copy.
  let west = merged[0][0], east = merged[merged.length - 1][1];
  let gap = 360 - (east - west);
  for (let index = 1; index < merged.length; index++) {
    const candidate = merged[index][0] - merged[index - 1][1];
    if (candidate > gap) {
      gap = candidate; west = merged[index][0]; east = merged[index - 1][1] + 360;
    }
  }
  // A gap may separate runs, never cut an edge. Vertex-only circular bounds can
  // fold a genuinely wide connected route back across itself.
  return { bounds: [[west, south], [east, north]], longitude: (lng) => lng < west ? lng + 360 : lng };
}
