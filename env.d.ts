/// <reference types="vite/client" />

declare module 'imagetracerjs' {
  const ImageTracer: {
    imagedataToSVG: (imgd: ImageData, options?: Record<string, unknown> | string) => string
  }
  export default ImageTracer
}

// LAN IPv4 of the dev machine (empty in production builds); see vite.config.ts.
declare const __DEV_LAN_HOST__: string
