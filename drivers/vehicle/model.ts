/**
 * Tesla VIN position 4 (index 3) encodes the vehicle line; "C" is Cybertruck.
 * Mirrors the same position already used for driver icon selection.
 */
export default function isCybertruck(vin: string | undefined): boolean {
  return vin?.[3] === "C";
}
