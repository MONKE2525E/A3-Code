/** Expose the shipped constructor through its own module scope or native loader. Credentials,
 * trust evaluation and Noise framing remain entirely in Muse's implementation. */
export const exposeMuseComputerStreamFactory = (source: string): string | null => {
  const hostedConstructorLoader = "let{connectNoiseBrowserSession:t}=await e.A(558113)";
  const hostedConstructorExport = 'e.s(["BrowserSessionSidePanel",0,function';
  const constructorLoaderPosition = source.indexOf(hostedConstructorLoader);
  if (constructorLoaderPosition >= 0) {
    const exportPosition = source.indexOf(hostedConstructorExport);
    if (
      source.indexOf(
        hostedConstructorLoader,
        constructorLoaderPosition + hostedConstructorLoader.length,
      ) >= 0 ||
      exportPosition < 0 ||
      source.indexOf(hostedConstructorExport, exportPosition + hostedConstructorExport.length) >=
        0 ||
      !source.includes("globalThis.TURBOPACK") ||
      !source.includes('100768,e=>{"use strict";') ||
      !source.includes("r=e.i(773309)")
    )
      return null;
    const loadFactory =
      "Object.defineProperty(window,'__t3MuseLoadComputerStreamFactory',{configurable:true,value:async()=>{const native=await e.A(558113);if(typeof native.connectNoiseBrowserSession!=='function')throw Error('computer_stream_unavailable');Object.defineProperty(window,'__t3MuseNativeComputerStream',{configurable:true,value:native.connectNoiseBrowserSession});}});";
    return source.slice(0, exportPosition) + loadFactory + source.slice(exportPosition);
  }
  const hostedLoader =
    "let u1=(0,r.lazy)(()=>e.A(781471).then(e=>({default:e.BrowserSessionSidePanel})))";
  const hostedPosition = source.indexOf(hostedLoader);
  if (hostedPosition >= 0) {
    if (
      source.indexOf(hostedLoader, hostedPosition + hostedLoader.length) >= 0 ||
      !source.includes("globalThis.TURBOPACK") ||
      !source.includes('e=>{"use strict";') ||
      !source.includes("r=e.i(773309)")
    )
      return null;
    const preload =
      "Object.defineProperty(window,'__t3MusePreloadComputerModule',{configurable:true,value:async()=>{await e.A(781471);if(typeof window.__t3MuseLoadComputerStreamFactory!=='function')throw Error('computer_stream_unavailable');await window.__t3MuseLoadComputerStreamFactory();}});";
    return source.slice(0, hostedPosition) + preload + source.slice(hostedPosition);
  }
  const marker = "function connectNoiseBrowserSession({gatewayUrl:";
  const position = source.indexOf(marker);
  if (position < 0 || source.indexOf(marker, position + marker.length) >= 0) return null;
  if (
    !source.includes("init_useNoiseBrowserSession=") ||
    !source.includes("useNoiseBrowserSession_exports=") ||
    !source.includes("NoiseWebSocketShim=class extends EventTarget")
  )
    return null;
  const hook =
    "Object.defineProperty(window,'__t3MuseNativeComputerStream',{configurable:true,value:input=>{init_useNoiseBrowserSession();return connectNoiseBrowserSession(input);}});";
  return source.slice(0, position) + hook + source.slice(position);
};
