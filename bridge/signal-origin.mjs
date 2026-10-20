// Browser WebSockets must have the page's Origin. Native URLSession has no web
// origin, so it presents a dedicated header and still has to pass pairing.
export function acceptedSignalOrigin(origin, nativeClient, expectedOrigin, allowedNative = 'ipad-native-v1') {
  return origin === expectedOrigin ||
    (origin === undefined && nativeClient === allowedNative);
}
