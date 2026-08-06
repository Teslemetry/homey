/**
 * Tesla VIN position 4 (index 3) encodes the vehicle line; "C" is Cybertruck.
 * Mirrors the same position already used for driver icon selection.
 */
export default function isCybertruck(vin: string | undefined): boolean {
  return vin?.[3] === "C";
}

/**
 * Bioweapon Defense Mode's HEPA filtration is exclusive to Model S and
 * Model X - Model 3/Y/Cybertruck don't have the hardware.
 */
export function isModelSorX(vin: string | undefined): boolean {
  return vin?.[3] === "S" || vin?.[3] === "X";
}
