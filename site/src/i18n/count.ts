/** DE/EN integer counts use the singular only for exactly one. */
export function countLabel(count: number, one: string, other: string): string {
  return count === 1 ? one : other;
}
