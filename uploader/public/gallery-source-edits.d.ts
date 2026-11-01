import type { GalleryBlock, GalleryLine } from '../../site/src/lib/gallery-source.js';
export interface GalleryEdit { start: number; end: number; text: string }
export function galleryLineEdits(line: GalleryLine, replacement: string): GalleryEdit[];
export function applyGalleryEdits(body: string, edits: GalleryEdit[]): string;
export function galleryContentEdit(body: string, block: GalleryBlock, content: string): { start: number; end: number; text: string };
