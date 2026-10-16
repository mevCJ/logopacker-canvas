/// <reference types="vite/client" />

declare module 'imagetracerjs' {
  const ImageTracer: {
    imagedataToSVG: (imgd: ImageData, options?: Record<string, unknown> | string) => string
  }
  export default ImageTracer
}
