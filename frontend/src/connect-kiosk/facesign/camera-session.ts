// Opt-in lasts for this kiosk tab. The CCTV server owns the actual phone session.
let pairedForKiosk = false;

export function isFacesignPaired(): boolean {
  return pairedForKiosk;
}

export function setFacesignPaired(paired: boolean): void {
  pairedForKiosk = paired;
}
