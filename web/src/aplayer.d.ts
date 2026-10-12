declare module "aplayer" {
  export default class APlayer {
    constructor(options: {
      container: HTMLElement; theme?: string; autoplay?: boolean; preload?: string; mutex?: boolean;
      lrcType?: number; audio: { name: string; artist: string; url: string; cover?: string; lrc?: string }[];
      loop?: "all" | "one" | "none"; order?: "list" | "random";
    });
    audio: HTMLAudioElement;
    on(event: string, callback: () => void): void;
    toggle(): void;
    seek(time: number): void;
    volume(percentage?: number, nostorage?: boolean): number;
    destroy(): void;
  }
}
