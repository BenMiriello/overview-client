/**
 * A custom ease-in-out cubic function, allowing setting any midpoint
 * @param t The total time in milliconds of the operation.
 * @param m The midway point of the easing curve, ex: 0.5 or 1/5
 * @returns 
 */
export function easeInOutCubicShifted(t: number, m: number) {
  // Reference function for cubic easing around the midpoint:
  // t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  return t < m
    ? Math.pow(t / m, 3) * m
    : m + (1 - Math.pow((1 - t) / (1 - m), 3)) * (1 - m);
}
