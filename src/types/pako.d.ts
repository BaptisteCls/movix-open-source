declare module 'pako' {
  export function ungzip(data: Uint8Array | ArrayBuffer, opts?: any): string | Uint8Array;
  export function inflate(data: Uint8Array | ArrayBuffer, opts?: any): string | Uint8Array;
  const pako: any;
  export default pako;
}
