import type { GalleryAnalysis } from '../../site/src/lib/gallery-source.js';

export type GalleryField = 'dimensions' | 'alt' | 'caption' | 'caption-override' | 'format' | 'unknown';
export type GalleryReason = 'unknown_field' | 'malformed_field' | 'invalid_dimensions' | 'unsupported_format';
export interface PhotoField { name: GalleryField | 'empty'; start: number; end: number }
export interface PhotoRecord {
  valid: true;
  raw: string;
  src: string;
  fields: PhotoField[];
  width?: number;
  height?: number;
  alt?: string;
  caption?: string;
  captionOverride?: string;
  format?: 'jpeg';
}
export interface InvalidPhoto {
  valid: false;
  raw: string;
  src: string;
  diagnostic: { field: GalleryField; reason: GalleryReason; offset: number };
}
export interface GalleryDiagnostic {
  code: 'invalid_gallery_metadata';
  line: number;
  column: number;
  field: GalleryField;
  reason: GalleryReason;
}
export interface GalleryWarning extends GalleryDiagnostic { locale: 'de' | 'en' }

export const MAX_GALLERY_TEXT: 1000;
export function escapeMeta(value: string): string;
export function unescapeMeta(value: string): string;
export function parsePhotoLine(raw: string): PhotoRecord | InvalidPhoto;
export function readCaptionOverride(line: string): string | undefined;
export function galleryDiagnostics(analysis: GalleryAnalysis): GalleryDiagnostic[];
export function galleryWarnings(analysis: GalleryAnalysis, locale: 'de' | 'en'): GalleryWarning[];
