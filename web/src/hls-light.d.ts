// hls.js's light build has the same API as the full one (minus features Mediarr doesn't use) but ships no types.
declare module 'hls.js/light' {
  import Hls from 'hls.js';
  export default Hls;
  export * from 'hls.js';
}
