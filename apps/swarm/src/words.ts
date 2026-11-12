/** `n` and `noun`, the noun in the plural (an added `s`) unless `n` is 1: `1 seat`, `0 seats`. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
