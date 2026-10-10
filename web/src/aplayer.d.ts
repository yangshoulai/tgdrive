declare module "aplayer" {
  export default class APlayer {
    constructor(options: {
      container: HTMLElement; theme?: string; autoplay?: boolean; preload?: string; mutex?: boolean;
      lrcType?: number; audio: { name: string; artist: string; url: string; cover?: string; lrc?: string }[];
    });
    audio: HTMLAudioElement;
    on(event: string, callback: () => void): void;
    toggle(): void;
    destroy(): void;
  }
}
