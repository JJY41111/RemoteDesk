export function clientProfile(client = 'ipad', tailnet = false) {
  if (!['ipad', 'pc'].includes(client)) throw new TypeError('Client must be ipad or pc');
  return Object.freeze({ client, mode: tailnet ? 'wan' : 'lan',
    privateDirectory: client === 'pc' ? 'private/pc' : 'private',
    diagnosticLog: client === 'pc' ? 'pc-session.log' : 'session.log',
    transferName: client === 'pc' ? 'pc傳輸' : 'ipad傳輸',
    nativeClient: client === 'pc' ? 'pc-native-v1' : 'ipad-native-v1' });
}
