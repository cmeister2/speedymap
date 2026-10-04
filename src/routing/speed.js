/** The first number in each recognised UK road reference, including A1(M). */
export function roadNumber(ref) {
  if (typeof ref !== 'string') return null;
  let minimum = Infinity;
  for (const reference of ref.split(';')) {
    const match = reference.trim().match(/^(?:A|B|C|M|U)\s*(\d+)(?:[a-z]|\s*\(\s*M\s*\)|\s+Toll)?$/i);
    if (!match) continue;
    const number = Number(match[1]);
    if (Number.isSafeInteger(number) && number > 0) minimum = Math.min(minimum, number);
  }
  return Number.isFinite(minimum) ? minimum : null;
}

export function effectiveSpeed(limitMph, ref, mode = 'numbered') {
  if (!Number.isFinite(limitMph) || limitMph <= 0) {
    throw new RangeError('A road speed limit must be greater than zero.');
  }
  const number = mode === 'numbered' || mode === 'number-only' ? roadNumber(ref) : null;
  return number === null ? limitMph : mode === 'number-only' ? number : Math.min(number, limitMph);
}

export const METRES_PER_MPH_SECOND = 0.44704;
