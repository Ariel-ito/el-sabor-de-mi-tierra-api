// Coordinates from the Google Maps links people share (WhatsApp, Maps app).
const PATTERNS = [
  /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/,
  /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/,
  /[?&](?:q|query|ll|destination|daddr)=(-?\d{1,2}\.\d+)(?:,|%2C)\s*(-?\d{1,3}\.\d+)/i,
  /\/(?:place|search|dir)\/(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/,
  /^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/,
];
export function coordinatesIn(text: string) {
  for (const re of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const latitude = Number(m[1]),
      longitude = Number(m[2]);
    if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180)
      return { latitude, longitude };
  }
  return null;
}
// Short links are only followed on Google's own hosts.
const HOSTS =
  /^(maps\.app\.goo\.gl|goo\.gl|g\.co|maps\.google\.[a-z.]+|(www\.)?google\.[a-z.]+)$/i;
export const isMapsHost = (url: URL) =>
  url.protocol === "https:" && HOSTS.test(url.hostname);
