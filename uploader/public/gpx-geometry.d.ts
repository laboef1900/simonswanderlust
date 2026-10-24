export interface PrivatePoint { lng: number; lat: number; elevation?: number; time?: string }
export interface PrivateGeometry { version: 1; segments: { points: PrivatePoint[] }[] }
export interface TrimSelection { startPoints: number; endPoints: number; removedSegments: number[] }
export interface TrimResult { geometry: PrivateGeometry; removedPoints: number; droppedSegments: number }
export const GPX_LIMITS: Readonly<{ fileBytes: 5242880; normalizedBytes: 12582912; points: 50000; segments: 100; waypoints: 500; nameCodePoints: 200; workerMs: 2000; nesting: 32 }>;
export function validateGeometry(value: unknown, allowEmpty?: boolean): asserts value is PrivateGeometry;
export function trimGeometry(geometry: PrivateGeometry, selection: TrimSelection): TrimResult;
export function selectionFromDistances(geometry: PrivateGeometry, removedSegments: number[], startMetres: number, endMetres: number): TrimSelection;
export function geometryStats(geometry: PrivateGeometry): { points: number; segments: number; distanceMetres: number };
