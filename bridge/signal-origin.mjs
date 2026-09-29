// Browser WebSockets must have the page's Origin. Native URLSession has no web
// origin, so it presents a dedicated header and still has to pass pairing.
export function acceptedSignalOrigin(origin, nativeClient, expectedOrigin) {
  return origin === expectedOrigin ||
    (origin === undefined && nativeClient === 'ipad-native-v1');
}
